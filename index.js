const http = require('http');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const https = require('https');
const urlModule = require('url');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

// Cloudflare Credentials (loaded from Environment Variables for security)
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const DATABASE_ID = process.env.CLOUDFLARE_DATABASE_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

// In-memory debug logs buffer (max 100 entries)
const debugLogs = [];
function logDebug(msg) {
    const timeStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const fullMsg = `[IST ${timeStr}] ${msg}`;
    console.log(fullMsg);
    debugLogs.push(fullMsg);
    if (debugLogs.length > 100) {
        debugLogs.shift();
    }
}

// Last cached prices to avoid duplicate logs in D1
const lastPrices = {
    "XAU_USD": 0.0,
    "XAG_USD": 0.0,
    "GOLD_MCX": 0.0,
    "SILVER_MCX": 0.0,
    "GOLD_999_GST": 0.0
};

// Simple D1 query wrapper
function queryD1(sql, params = []) {
    return new Promise((resolve, reject) => {
        const payloadStr = JSON.stringify({ sql, params });
        const payloadBuf = Buffer.from(payloadStr, 'utf8');
        const options = {
            hostname: 'api.cloudflare.com',
            path: `/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json',
                'Content-Length': payloadBuf.length
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        logDebug(`D1 JSON Parse Error: ${e.message}`);
                        reject(e);
                    }
                } else {
                    const errMsg = `D1 HTTP Error: ${res.statusCode} - ${body}`;
                    logDebug(errMsg);
                    reject(new Error(errMsg));
                }
            });
        });

        req.on('error', (e) => {
            logDebug(`D1 Request Network Error: ${e.message}`);
            reject(e);
        });
        req.write(payloadBuf);
        req.end();
    });
}

// Fetch helper using curl to avoid TLS fingerprint blocks (e.g. Cloudflare)
function fetchUrl(url, headers = {}) {
    return new Promise((resolve, reject) => {
        let headersStr = '';
        const mergedHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ...headers
        };
        for (const [key, val] of Object.entries(mergedHeaders)) {
            headersStr += ` -H "${key}: ${val}"`;
        }
        const cmd = `curl -s -L -k --ssl-no-revoke${headersStr} "${url}"`;
        exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

function toDoubleSafe(value) {
    if (value === null || value === undefined) return 0.0;
    const num = Number(value);
    return isNaN(num) ? 0.0 : num;
}

// Get current date string in IST timezone (YYYY-MM-DD)
function getIstDateString() {
    const d = new Date();
    const istTime = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
    return istTime.toISOString().split('T')[0];
}

// Check if a date is in US Daylight Saving Time (DST)
function isUsDst(date) {
    const year = date.getFullYear();
    
    // US DST starts on the second Sunday of March
    let marchSunday = new Date(year, 2, 8); // March 8th
    while (marchSunday.getDay() !== 0) {
        marchSunday.setDate(marchSunday.getDate() + 1);
    }
    
    // US DST ends on the first Sunday of November
    let novSunday = new Date(year, 10, 1); // November 1st
    while (novSunday.getDay() !== 0) {
        novSunday.setDate(novSunday.getDate() + 1);
    }
    
    return date >= marchSunday && date < novSunday;
}

// Get date string for an asset based on US DST (for Spot assets) or normal IST (for others)
function getAssetDateStringForTimestamp(asset, timestampMs) {
    const istTimeMs = timestampMs + (5.5 * 60 * 60 * 1000);
    const istDate = new Date(istTimeMs);
    
    if (asset === "XAU_USD" || asset === "XAG_USD") {
        const dst = isUsDst(istDate);
        const shiftMinutes = dst ? (3 * 60 + 31) : (4 * 60 + 31); // Summer: 3:31:00 AM to 2:30:59 AM IST | Winter: 4:31:00 AM to 3:30:59 AM IST
        const shiftedDate = new Date(istTimeMs - shiftMinutes * 60 * 1000);
        return shiftedDate.toISOString().split('T')[0];
    } else {
        return istDate.toISOString().split('T')[0];
    }
}

// Get shifted date string for spot gold/silver based on US DST (3:31 AM Summer / 4:31 AM Winter transition)
function getSpotAssetDateString() {
    return getAssetDateStringForTimestamp("XAU_USD", Date.now());
}

// Calculate start and end millisecond timestamps for a given YYYY-MM-DD date and asset (DST aware)
function getTimestampRangeForDate(asset, dateStr) {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return null;
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    const day = parseInt(parts[2]);
    
    const mStr = month < 10 ? '0' + month : '' + month;
    const dStr = day < 10 ? '0' + day : '' + day;
    const midnightIstMs = new Date(`${year}-${mStr}-${dStr}T00:00:00+05:30`).getTime();
    
    let startMs = midnightIstMs;
    let endMs = midnightIstMs + 24 * 60 * 60 * 1000 - 1;
    
    if (asset === "XAU_USD" || asset === "XAG_USD") {
        const dateForDst = new Date(midnightIstMs);
        const dst = isUsDst(dateForDst);
        const shiftMs = dst ? ((3 * 3600 + 31 * 60) * 1000) : ((4 * 3600 + 31 * 60) * 1000);
        startMs += shiftMs;
        endMs += shiftMs;
    } else if (asset === "GOLD_MCX" || asset === "SILVER_MCX" || asset === "GOLD_999_GST") {
        // Explicit 9:00:10 AM IST to 11:55:10 PM IST session range for MCX & GST
        startMs = midnightIstMs + (9 * 3600 + 10) * 1000;
        endMs = midnightIstMs + (23 * 3600 + 55 * 60 + 10) * 1000;
    }
    
    return { startMs, endMs };
}

const inMemoryTicks = {};

async function saveIntradayTick(asset, price) {
    const currentPrice = toDoubleSafe(price);
    if (currentPrice <= 0.0) return;

    // Record ticks unconditionally every 10 seconds as requested (even if rate is unchanged)
    lastPrices[asset] = currentPrice;
    const timestamp = Date.now();

    if (!inMemoryTicks[asset]) {
        inMemoryTicks[asset] = [];
    }
    // Newest first (consistent with ORDER BY timestamp DESC)
    inMemoryTicks[asset].unshift({ timestamp, price: currentPrice });
    if (inMemoryTicks[asset].length > 10000) {
        inMemoryTicks[asset].pop();
    }

    try {
        await queryD1(
            "INSERT INTO intraday_prices (asset, price, timestamp) VALUES (?, ?, ?)",
            [asset, currentPrice, timestamp]
        );
        logDebug(`[TICK] Inserted ${asset}: ${currentPrice}`);
    } catch (e) {
        logDebug(`[TICK ERROR] Failed to save tick for ${asset}: ${e.message}`);
    }
}

const inMemoryOhlc = {};
const lastD1OhlcSync = {};

async function saveDailySummary(asset, dateStr, open, high, low, close) {
    const timestamp = Date.now();
    const isCorruptedOpen = (val) => (!val || val <= 0 || val === 4521.45 || val === 4522.65 || val === 4333.85);

    // 1. ALWAYS update inMemoryOhlc immediately in RAM (Zero latency, 100% immune to D1 errors)
    if (!inMemoryOhlc[asset] || inMemoryOhlc[asset].date !== dateStr) {
        const finalOpen = !isCorruptedOpen(open) ? open : close;
        inMemoryOhlc[asset] = {
            asset,
            date: dateStr,
            open: finalOpen,
            high: Math.max(high || 0.0, close),
            low: low > 0 ? low : close,
            close: close,
            timestamp: timestamp
        };
    } else {
        const cached = inMemoryOhlc[asset];
        if (isCorruptedOpen(cached.open) && !isCorruptedOpen(open)) {
            cached.open = open;
        }
        cached.high = Math.max(cached.high || 0.0, high || 0.0, close);
        if (low > 0) {
            cached.low = cached.low > 0 ? Math.min(cached.low, low) : low;
        }
        cached.close = close;
        cached.timestamp = timestamp;
    }

    // 2. Throttled async update to D1 (once every 30s per asset) using clean UPDATE / INSERT
    const now = Date.now();
    const lastSync = lastD1OhlcSync[asset] || 0;
    if (now - lastSync >= 30000) {
        lastD1OhlcSync[asset] = now;
        try {
            const current = inMemoryOhlc[asset];
            const updRes = await queryD1(
                "UPDATE prices SET open = ?, high = ?, low = ?, close = ?, timestamp = ? WHERE asset = ? AND date = ?",
                [current.open, current.high, current.low, current.close, timestamp, asset, dateStr]
            );
            if (updRes?.result?.[0]?.meta?.changes === 0) {
                await queryD1(
                    "INSERT INTO prices (asset, date, open, high, low, close, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [asset, dateStr, current.open, current.high, current.low, current.close, timestamp]
                );
            }
        } catch (e) {
            // Safe ignore
        }
    }
}

// 1. Sync Spot Assets (Gold, Silver, USD_INR) via Yahoo Finance API (COMEX GC=F, SI=F, INR=X)
async function syncSpotAsset(assetName, yahooTicker, syncHistory = false) {
    try {
        const range = syncHistory ? "3y" : "5d";
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=${range}`;
        const raw = await fetchUrl(url);
        const yahooData = JSON.parse(raw);
        const result = yahooData.chart?.result?.[0];
        
        if (result && result.timestamp && result.indicators && result.indicators.quote && result.indicators.quote[0]) {
            const quote = result.indicators.quote[0];
            const timestamps = result.timestamp;
            
            if (syncHistory) {
                // Loop through all historical data points to fill in D1 database
                const todayStr = getIstDateString();
                let syncCount = 0;
                for (let i = 0; i < timestamps.length; i++) {
                    const openVal = toDoubleSafe(quote.open[i]);
                    const closeVal = toDoubleSafe(quote.close[i]);
                    const highVal = toDoubleSafe(quote.high[i]) || closeVal;
                    const lowVal = toDoubleSafe(quote.low[i]) || closeVal;
                    
                    if (closeVal > 0.0) {
                        const date = new Date(timestamps[i] * 1000);
                        const istTime = new Date(date.getTime() + (5.5 * 60 * 60 * 1000));
                        const dateStr = istTime.toISOString().split('T')[0];
                        
                        if (dateStr === todayStr) {
                            continue;
                        }
                        
                        await saveDailySummary(assetName, dateStr, openVal, highVal, lowVal, closeVal);
                        syncCount++;
                    }
                }
                logDebug(`[HISTORY] Synced ${syncCount} historical entries for ${assetName}`);
            } else {
                // Only sync the latest element for the 10-second tick
                const idx = timestamps.length - 1;
                if (idx >= 0) {
                    const openVal = toDoubleSafe(quote.open[idx]);
                    const closeVal = toDoubleSafe(quote.close[idx]);
                    const highVal = toDoubleSafe(quote.high[idx]) || closeVal;
                    const lowVal = toDoubleSafe(quote.low[idx]) || closeVal;
                    
                    if (closeVal > 0.0) {
                        const spotDateStr = getSpotAssetDateString();
                        await saveDailySummary(assetName, spotDateStr, closeVal, closeVal, closeVal, closeVal);
                        await saveIntradayTick(assetName, closeVal);
                    }
                }
            }
        }
    } catch (e) {
        logDebug(`Error syncing spot asset ${assetName}: ${e.message}`);
    }
}



// 2. Sync MCX Assets (Gold, Silver)
async function syncMcxAsset(assetName, pageUrl, symbolPrefix, syncHistory = false) {
    try {
        const html = await fetchUrl(pageUrl);
        
        let expiryDate = null;
        const expiryDates = [];

        const defaultExpiryMatch = html.match(/"default_expiry"\s*:\s*\[\s*"([^"]+)"/i);
        if (defaultExpiryMatch) {
            expiryDate = defaultExpiryMatch[1];
        }

        const dataListMatch = html.match(/"dataList"\s*:\s*\[(.*?)\]\s*,\s*"default_expiry"/i);
        if (dataListMatch) {
            const dlContent = dataListMatch[1];
            const dateMatches = dlContent.match(/"\d{4}-\d{2}-\d{2}"/g) || [];
            dateMatches.forEach(d => expiryDates.push(d.replace(/"/g, '')));
        }

        if (!expiryDate) return;

        // Apply Option A Rollover Logic
        if (expiryDates.length > 1) {
            const parts = expiryDate.split("-");
            if (parts.length === 3) {
                const expYear = parseInt(parts[0]);
                const expMonth = parseInt(parts[1]);
                const expDay = parseInt(parts[2]);

                let rollMonth = expMonth - 1;
                let rollYear = expYear;
                if (rollMonth === 0) {
                    rollMonth = 12;
                    rollYear -= 1;
                }

                const today = new Date();
                const todayYear = today.getFullYear();
                const todayMonth = today.getMonth() + 1;
                const todayDay = today.getDate();

                const switchDay = rollMonth === 2 ? 28 : 30;

                const isRolloverMonth = (todayYear === rollYear && todayMonth === rollMonth && todayDay >= switchDay);
                const isExpiryMonthBeforeExpiry = (todayYear === expYear && todayMonth === expMonth && todayDay < expDay);

                if (isRolloverMonth || isExpiryMonthBeforeExpiry) {
                    if (expiryDates[1]) {
                        expiryDate = expiryDates[1];
                    }
                }
            }
        }

        const toTimestamp = Math.floor(Date.now() / 1000);
        const daysBack = syncHistory ? 1095 : 5;
        const fromTimestamp = toTimestamp - daysBack * 24 * 3600;

        const sym = `${symbolPrefix}_${expiryDate}_MCX`;
        const historyUrl = `https://priceapi.moneycontrol.com/techCharts/commodity/history?symbol=${sym}&resolution=D&from=${fromTimestamp}&to=${toTimestamp}`;
        const raw = await fetchUrl(historyUrl);
        const tvcData = JSON.parse(raw);

        if (tvcData.s === "ok" && tvcData.t && tvcData.o) {
            if (syncHistory) {
                // Loop through all historical data points to fill in D1 database
                const todayStr = getIstDateString();
                let syncCount = 0;
                for (let i = 0; i < tvcData.t.length; i++) {
                    const openVal = toDoubleSafe(tvcData.o[i]);
                    const closeVal = toDoubleSafe(tvcData.c[i]);
                    const highVal = toDoubleSafe(tvcData.h[i]) || closeVal;
                    const lowVal = toDoubleSafe(tvcData.l[i]) || closeVal;

                    if (closeVal > 0.0) {
                        const date = new Date(tvcData.t[i] * 1000);
                        const istTime = new Date(date.getTime() + (5.5 * 60 * 60 * 1000));
                        const dateStr = istTime.toISOString().split('T')[0];
                        
                        if (dateStr === todayStr) {
                            continue;
                        }
                        
                        await saveDailySummary(assetName, dateStr, openVal, highVal, lowVal, closeVal);
                        
                        // Dynamically generate and sync GST Gold history from MCX Gold history
                        if (assetName === "GOLD_MCX") {
                            await saveDailySummary("GOLD_999_GST", dateStr, openVal * 1.0354, highVal * 1.0354, lowVal * 1.0354, closeVal * 1.0354);
                        }
                        
                        syncCount++;
                    }
                }
                logDebug(`[HISTORY] Synced ${syncCount} historical entries for ${assetName}`);
                if (assetName === "GOLD_MCX") {
                    logDebug(`[HISTORY] Dynamically generated ${syncCount} historical entries for GOLD_999_GST`);
                }
            } else {
                const dateStr = getIstDateString();
                const idx = tvcData.t.length - 1;
                if (idx >= 0) {
                    const openVal = toDoubleSafe(tvcData.o[idx]);
                    const closeVal = toDoubleSafe(tvcData.c[idx]);
                    const highVal = toDoubleSafe(tvcData.h[idx]) || closeVal;
                    const lowVal = toDoubleSafe(tvcData.l[idx]) || closeVal;

                    if (closeVal > 0.0) {
                        await saveDailySummary(assetName, dateStr, openVal > 0 ? openVal : closeVal, highVal, lowVal, closeVal);
                        await saveIntradayTick(assetName, closeVal);
                    }
                }
            }
        }
    } catch (e) {
        logDebug(`Error syncing MCX asset ${assetName}: ${e.message}`);
    }
}

// 3. Sync Harikala Broadcast Rates (Spot Gold, Spot Silver, USD_INR, and GOLD_999_GST)
async function syncHarikalaBroadcast() {
    try {
        const url = "https://bcast.harikalabullion.com:7768/VOTSBroadcastStreaming/Services/xml/GetLiveRateByTemplateID/harikala";
        const raw = await fetchUrl(url);
        const lines = raw.split("\n");
        const dateStr = getIstDateString();
        
        const d = new Date();
        const istTime = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
        const secondsSinceMidnight = istTime.getUTCHours() * 3600 + istTime.getUTCMinutes() * 60 + istTime.getUTCSeconds();
        
        const startSeconds = 9 * 3600 + 10; // 09:00:10 AM IST
        const endSeconds = 23 * 3600 + 50 * 60; // 11:50:00 PM IST
        const isMcxGstMarketOpen = secondsSinceMidnight >= startSeconds && secondsSinceMidnight <= endSeconds;
        
        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            
            const parts = line.split("\t").map(p => p.trim());
            if (parts.length < 5) continue;
            
            const name = parts[1]; // Index 1 is the asset name
            const closeVal = toDoubleSafe(parts[3]); // Index 3 is the close/ask price
            const bidVal = parts[2] === '-' ? closeVal : toDoubleSafe(parts[2]); // Index 2 is bid/open
            const highVal = parts[4] ? toDoubleSafe(parts[4]) : closeVal;
            const lowVal = parts[5] ? toDoubleSafe(parts[5]) : closeVal;
            const openVal = bidVal > 0 ? bidVal : closeVal;
            
            if (closeVal <= 0.0) continue;
            
            if (name === "GOLD") {
                // Spot Gold
                const spotDateStr = getSpotAssetDateString();
                await saveDailySummary("XAU_USD", spotDateStr, closeVal, closeVal, closeVal, closeVal);
                await saveIntradayTick("XAU_USD", closeVal);
                logDebug(`[HARIKALA-SPOT] Synced XAU_USD: ${closeVal} with date ${spotDateStr}`);
            }
            else if (name === "SILVER") {
                // Spot Silver
                const spotDateStr = getSpotAssetDateString();
                await saveDailySummary("XAG_USD", spotDateStr, closeVal, closeVal, closeVal, closeVal);
                await saveIntradayTick("XAG_USD", closeVal);
                logDebug(`[HARIKALA-SPOT] Synced XAG_USD: ${closeVal} with date ${spotDateStr}`);
            }
            else if (name === "GOLD FUTURE") {
                // MCX Gold Future (Only during active trading hours: 09:00:10 AM - 11:50:00 PM IST)
                if (isMcxGstMarketOpen) {
                    await saveDailySummary("GOLD_MCX", dateStr, openVal, highVal, lowVal, closeVal);
                    await saveIntradayTick("GOLD_MCX", closeVal);
                    logDebug(`[HARIKALA-MCX] Synced GOLD_MCX: ${closeVal}`);
                }
            }
            else if (name === "SILVER FUTURE") {
                // MCX Silver Future (Only during active trading hours: 09:00:10 AM - 11:50:00 PM IST)
                if (isMcxGstMarketOpen) {
                    await saveDailySummary("SILVER_MCX", dateStr, openVal, highVal, lowVal, closeVal);
                    await saveIntradayTick("SILVER_MCX", closeVal);
                    logDebug(`[HARIKALA-MCX] Synced SILVER_MCX: ${closeVal}`);
                }
            }
            else if (name === "GOLD 999 IMP WITH GST (Today)") {
                // GST Gold (Only during active trading hours: 09:00:10 AM - 11:50:00 PM IST)
                if (isMcxGstMarketOpen) {
                    await saveDailySummary("GOLD_999_GST", dateStr, openVal, highVal, lowVal, closeVal);
                    await saveIntradayTick("GOLD_999_GST", closeVal);
                    logDebug(`[HARIKALA-SPOT] Synced GOLD_999_GST: ${closeVal}`);
                }
            }
        }
    } catch (e) {
        logDebug(`Error syncing Harikala Broadcast: ${e.message}`);
    }
}

// Main sync scheduling loop
async function runSyncCycle() {
    logDebug(`[SYNC CYCLE START]`);

    // Run all live sync queries
    try {
        await syncHarikalaBroadcast();
    } catch (err) {
        logDebug(`Error in live sync: ${err.message}`);
    }

    logDebug(`[SYNC CYCLE END]`);
}

// WhatsApp Baileys State & Integration
let waSock = null;
let latestQrCode = null;
let isWaConnected = false;
let waConnectedUser = null;
let lastSent11AmDate = '';
const waSchedulerLogs = [];

let isWaInitializing = false;
let waReconnectTimer = null;

function logWa(msg) {
    const istNow = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const entry = `[IST ${istNow}] ${msg}`;
    waSchedulerLogs.push(entry);
    if (waSchedulerLogs.length > 100) waSchedulerLogs.shift();
    logDebug(msg);
}

const WA_CONFIG_FILE = path.join(__dirname, 'whatsapp_config.json');

const DEFAULT_WA_TEMPLATE = `⭐ *HARIKALA BULLION LLP* ⭐

{RATES}

*FOR BOOKING*
☎️:-0261-2564900
☎️:-0261-2564901
📱:-9978593937
📱:-9925593937

👇 *Visit for live rate* 👇 

Website :- www.harikalabullion.com

Play Store :- https://play.google.com/store/apps/details?id=com.chirayusoft.harikalabullion

App store :- https://apps.apple.com/in/app/harikala-bullion/id1518372373`;

function loadWaConfig() {
    let cfg = {
        targetGroupId: '',
        targetGroupIds: [],
        customHeader: '⭐ *HARIKALA BULLION LLP* ⭐',
        customTemplate: DEFAULT_WA_TEMPLATE,
        autoSendEnabled: true,
        autoSendTime: '11:00',
        autoSendTimes: ['11:00'],
        skipSunday: true,
        selectedScripts: ['GOLD_999_GST'],
        lastSentKey: '',
        lastSentKeys: []
    };
    try {
        if (fs.existsSync(WA_CONFIG_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(WA_CONFIG_FILE, 'utf8'));
            let gIds = [];
            if (Array.isArray(parsed.targetGroupIds) && parsed.targetGroupIds.length > 0) {
                gIds = parsed.targetGroupIds;
            } else if (parsed.targetGroupId) {
                gIds = [parsed.targetGroupId];
            }
            let timesList = [];
            if (Array.isArray(parsed.autoSendTimes) && parsed.autoSendTimes.length > 0) {
                timesList = parsed.autoSendTimes;
            } else if (parsed.autoSendTime) {
                timesList = [parsed.autoSendTime];
            } else {
                timesList = ['11:00'];
            }
            timesList = Array.from(new Set(timesList.map(t => normalizeTimeStr(t)).filter(t => t.length > 0)));

            let sentKeysList = Array.isArray(parsed.lastSentKeys) ? parsed.lastSentKeys : [];
            if (parsed.lastSentKey && !sentKeysList.includes(parsed.lastSentKey)) {
                sentKeysList.push(parsed.lastSentKey);
            }

            cfg = {
                targetGroupId: gIds[0] || parsed.targetGroupId || '',
                targetGroupIds: gIds,
                customHeader: parsed.customHeader || '⭐ *HARIKALA BULLION LLP* ⭐',
                customTemplate: parsed.customTemplate || DEFAULT_WA_TEMPLATE,
                autoSendEnabled: parsed.autoSendEnabled !== undefined ? parsed.autoSendEnabled : (parsed.autoSend11Am !== undefined ? parsed.autoSend11Am : true),
                autoSendTime: timesList[0] || '11:00',
                autoSendTimes: timesList,
                skipSunday: parsed.skipSunday !== undefined ? parsed.skipSunday : true,
                selectedScripts: Array.isArray(parsed.selectedScripts) && parsed.selectedScripts.length > 0 ? parsed.selectedScripts : ['GOLD_999_GST'],
                lastSentKey: parsed.lastSentKey || '',
                lastSentKeys: sentKeysList
            };
        }
    } catch (e) {
        logDebug(`[WA CONFIG READ ERROR] ${e.message}`);
    }
    return cfg;
}

function saveWaConfig(cfg) {
    try {
        fs.writeFileSync(WA_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
        logDebug(`[WA CONFIG SAVED] ${JSON.stringify(cfg)}`);
    } catch (e) {
        logDebug(`[WA CONFIG SAVE ERROR] ${e.message}`);
    }
}

async function initWhatsApp() {
    if (isWaInitializing) {
        logDebug('[WA] Init call skipped: Initialization already in progress.');
        return;
    }
    isWaInitializing = true;

    if (waReconnectTimer) {
        clearTimeout(waReconnectTimer);
        waReconnectTimer = null;
    }

    try {
        logDebug('[WA] Initializing Baileys WhatsApp client...');
        
        // Safely close and strip previous socket instance if any
        if (waSock) {
            try {
                waSock.ev.removeAllListeners('connection.update');
                waSock.ev.removeAllListeners('creds.update');
                waSock.end(undefined);
            } catch (se) {}
            waSock = null;
        }

        const authFolder = path.join(__dirname, 'auth_info_baileys');
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        
        let version = [2, 3000, 1015901307];
        try {
            const vRes = await fetchLatestBaileysVersion();
            if (vRes?.version) version = vRes.version;
            logDebug(`[WA] Using WhatsApp Web version v${version.join('.')}`);
        } catch (ve) {
            logDebug(`[WA VERSION FETCH WARN] ${ve.message}, using fallback version.`);
        }

        waSock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            auth: state,
            browser: Browsers.macOS('Desktop'),
            syncFullHistory: false,
            generateHighQualityLinkPreview: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000
        });

        waSock.ev.on('creds.update', saveCreds);

        waSock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                latestQrCode = qr;
                isWaConnected = false;
                logDebug('[WA] New QR code generated. Ready to scan.');
            }
            if (connection === 'close') {
                latestQrCode = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const isReplaced = statusCode === DisconnectReason.connectionReplaced;

                logDebug(`[WA] Connection closed: ${lastDisconnect?.error?.message || 'closed'} (code ${statusCode}).`);
                
                if (isLoggedOut || isReplaced) {
                    isWaConnected = false;
                    waConnectedUser = null;
                    logDebug('[WA] Logged out or session replaced. Clearing credentials folder...');
                    try {
                        fs.rmSync(path.join(__dirname, 'auth_info_baileys'), { recursive: true, force: true });
                    } catch (e) {}
                } else {
                    const credsExist = fs.existsSync(path.join(authFolder, 'creds.json'));
                    if (!credsExist) {
                        isWaConnected = false;
                    }
                }
                
                // Reconnect cleanly using single-instance guarded timer
                if (!isLoggedOut && !waReconnectTimer) {
                    waReconnectTimer = setTimeout(() => {
                        waReconnectTimer = null;
                        isWaInitializing = false;
                        initWhatsApp();
                    }, 3000);
                } else {
                    isWaInitializing = false;
                }
            } else if (connection === 'connecting') {
                logDebug('[WA] Connecting to WhatsApp servers...');
            } else if (connection === 'open') {
                isWaConnected = true;
                latestQrCode = null;
                isWaInitializing = false;
                waConnectedUser = waSock.user?.name || waSock.user?.id || 'Connected User';
                logDebug(`[WA] ✅ WhatsApp Connected Successfully! User: ${waConnectedUser}`);
            }
        });
    } catch (e) {
        isWaInitializing = false;
        logDebug(`[WA INIT ERROR] ${e.message}`);
    }
}

async function sendGoldGstRateMessage(customGroupId = null) {
    const config = loadWaConfig();
    let targetIds = [];

    if (customGroupId && customGroupId.trim().length > 0) {
        targetIds = [customGroupId.trim()];
    } else if (Array.isArray(config.targetGroupIds) && config.targetGroupIds.length > 0) {
        targetIds = config.targetGroupIds.map(id => (typeof id === 'string' ? id.trim() : '')).filter(id => id.length > 0);
    } else if (config.targetGroupId && config.targetGroupId.trim().length > 0) {
        targetIds = [config.targetGroupId.trim()];
    }

    targetIds = Array.from(new Set(targetIds));

    if (!isWaConnected || !waSock) {
        throw new Error("WhatsApp client is not connected. Scan QR code first.");
    }

    if (targetIds.length === 0) {
        throw new Error("No target WhatsApp Group selected. Please select at least one group in App.");
    }

    const selectedScripts = config.selectedScripts || ['GOLD_999_GST'];
    
    // Fetch latest prices for selected scripts
    const pricesMap = {};
    for (const script of selectedScripts) {
        let price = lastPrices[script] || 0.0;
        try {
            const dbRes = await queryD1(
                "SELECT close FROM prices WHERE asset = ? ORDER BY date DESC LIMIT 1",
                [script]
            );
            const rows = dbRes?.result?.[0]?.results || [];
            if (rows.length > 0 && rows[0].close > 0) {
                price = rows[0].close;
            }
        } catch (e) {
            logDebug(`[WA RATE FETCH WARNING ${script}] ${e.message}`);
        }
        pricesMap[script] = price;
    }

    // Format rates block
    const ratesLines = [];
    selectedScripts.forEach(script => {
        const val = pricesMap[script] || 0;
        if (script === 'GOLD_999_GST') {
            ratesLines.push(`*999 (100 GM BAR)*\n🟡 *RTGS :- ${Math.round(val)}*`);
        } else if (script === 'XAU_USD') {
            ratesLines.push(`🟡 *Spot Gold :- $${val.toFixed(2)}*`);
        } else if (script === 'XAG_USD') {
            ratesLines.push(`⚪ *Spot Silver :- $${val.toFixed(4)}*`);
        } else if (script === 'GOLD_MCX') {
            ratesLines.push(`🟡 *Gold MCX :- ₹${Math.round(val)}*`);
        } else if (script === 'SILVER_MCX') {
            ratesLines.push(`⚪ *Silver MCX :- ₹${Math.round(val)}*`);
        }
    });

    const ratesBlockText = ratesLines.join('\n\n');
    let template = config.customTemplate && config.customTemplate.trim().length > 0 ? config.customTemplate : DEFAULT_WA_TEMPLATE;
    const messageText = template.includes('{RATES}') ? template.replace('{RATES}', ratesBlockText) : `${template}\n\n${ratesBlockText}`;

    const sendResults = [];
    logWa(`[WA BROADCAST] Starting multi-group dispatch to ${targetIds.length} group(s): ${JSON.stringify(targetIds)}`);

    for (let i = 0; i < targetIds.length; i++) {
        const gid = targetIds[i];
        const formattedJid = gid.includes('@') ? gid : `${gid}@g.us`;
        let groupSuccess = false;
        let lastErr = null;

        // Up to 3 retries per group with socket recovery delay (skip retries if forbidden)
        let isForbidden = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                if (!isWaConnected || !waSock) {
                    logWa(`[WA BROADCAST ${i + 1}/${targetIds.length}] Waiting 2s for WhatsApp socket recovery (attempt ${attempt}/3)...`);
                    await new Promise(r => setTimeout(r, 2000));
                    if (!waSock) throw new Error("Socket disconnected during broadcast");
                }
                logWa(`[WA BROADCAST ${i + 1}/${targetIds.length}] Sending to group ${formattedJid} (attempt ${attempt}/3)...`);
                await waSock.sendMessage(formattedJid, { text: messageText });
                logWa(`[WA SENT SUCCESS ${i + 1}/${targetIds.length}] ✅ Sent to group: ${formattedJid}`);
                groupSuccess = true;
                sendResults.push({ groupId: formattedJid, success: true, attempts: attempt });
                break;
            } catch (err) {
                lastErr = err;
                const errMsg = err?.message || String(err);
                if (errMsg.toLowerCase().includes('forbidden') || errMsg.toLowerCase().includes('not-authorized') || errMsg.toLowerCase().includes('not in group')) {
                    isForbidden = true;
                    logWa(`[WA PERMISSION WARN ${i + 1}/${targetIds.length}] ⛔ Account does not have permission to post in group ${formattedJid} (forbidden). Skipping retries.`);
                    break;
                }
                logWa(`[WA SEND WARN ${i + 1}/${targetIds.length}] Attempt ${attempt}/3 failed for ${formattedJid}: ${errMsg}`);
                if (attempt < 3) {
                    await new Promise(r => setTimeout(r, 2500));
                }
            }
        }

        if (!groupSuccess) {
            logWa(`[WA SEND ERROR ${i + 1}/${targetIds.length}] ❌ Group ${formattedJid} failed: ${lastErr?.message}`);
            sendResults.push({ groupId: formattedJid, success: false, isForbidden, error: lastErr?.message || 'Failed' });
        }

        if (i < targetIds.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2500));
        }
    }

    const sentCount = sendResults.filter(r => r.success).length;
    const handledCount = sendResults.filter(r => r.success || r.isForbidden).length;
    const isCompleted = handledCount === targetIds.length && sentCount > 0;

    return { success: isCompleted, targetCount: targetIds.length, sentCount, sendResults, messageText };
}

function normalizeTimeStr(tStr) {
    if (!tStr) return "";
    const clean = tStr.trim();
    const parts = clean.split(':');
    if (parts.length < 2) return clean;
    const h = String(parseInt(parts[0], 10)).padStart(2, '0');
    const m = String(parseInt(parts[1], 10)).padStart(2, '0');
    return `${h}:${m}`;
}

function getIstTimeInfo() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const parts = formatter.formatToParts(now);
    const p = {};
    parts.forEach(item => { p[item.type] = item.value; });
    
    let hourStr = p.hour === '24' ? '00' : p.hour;
    const timeFormatted = `${hourStr}:${p.minute}`;
    const todayIstStr = `${p.year}-${p.month}-${p.day}`;

    const dayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
    const isSunday = dayFormatter.format(now) === 'Sun';

    return { timeFormatted, todayIstStr, isSunday, seconds: p.second };
}

// Configurable Daily WhatsApp Auto-Sender Loop
let lastSentWaKey = "";
const activeSendsInProgress = new Set();

setInterval(async () => {
    try {
        const { timeFormatted, todayIstStr, isSunday } = getIstTimeInfo();
        const config = loadWaConfig();

        if (!config.autoSendEnabled) {
            return;
        }

        if (!isWaConnected || !waSock) {
            return; // Wait until WhatsApp socket is connected
        }

        if (config.skipSunday && isSunday) {
            return; // Do not auto-send on Sundays!
        }

        const timesList = config.autoSendTimes && config.autoSendTimes.length > 0 ? config.autoSendTimes : [config.autoSendTime || '11:00'];
        const normCurr = normalizeTimeStr(timeFormatted);
        const sentKeys = Array.isArray(config.lastSentKeys) ? [...config.lastSentKeys] : (config.lastSentKey ? [config.lastSentKey] : []);

        for (const tTime of timesList) {
            const normTarget = normalizeTimeStr(tTime);
            const sendKey = `${todayIstStr}_${normTarget}`;

            if (sentKeys.includes(sendKey)) {
                continue; // Already successfully sent today for this time!
            }

            if (activeSendsInProgress.has(sendKey)) {
                continue; // Dispatch already in progress for this key
            }

            if (normCurr === normTarget) {
                logWa(`[WA SCHEDULER] ⏰ Match found! Current IST: ${normCurr}, Target Time: ${normTarget}. Triggering rate send...`);
                
                activeSendsInProgress.add(sendKey);
                try {
                    const res = await sendGoldGstRateMessage();
                    if (res && res.success) {
                        // ONLY mark sendKey as SENT after successful dispatch!
                        const freshConfig = loadWaConfig();
                        const currentSent = Array.isArray(freshConfig.lastSentKeys) ? freshConfig.lastSentKeys : [];
                        const updatedSentKeys = Array.from(new Set([...currentSent, sendKey]));
                        saveWaConfig({ ...freshConfig, lastSentKey: sendKey, lastSentKeys: updatedSentKeys });
                        logWa(`[WA SCHEDULER SUCCESS] ✅ Rate message sent successfully at ${normCurr} IST for time ${normTarget}! (Targets: ${res.sentCount}/${res.targetCount})`);
                    } else {
                        logWa(`[WA SCHEDULER WARN] ⚠️ Rate message send attempted at ${normCurr} IST for time ${normTarget} but result was not successful. Will retry in next 10s tick within minute window.`);
                    }
                } catch (sendErr) {
                    logWa(`[WA SCHEDULER ERROR] ❌ Failed to send rate message for time ${normTarget}: ${sendErr.message}`);
                } finally {
                    activeSendsInProgress.delete(sendKey);
                }
            }
        }
    } catch (e) {
        logWa(`[WA SCHEDULER CRITICAL ERROR] ${e.message}`);
    }
}, 10000);

// In-memory response cache for /api/live endpoint
let liveCacheData = null;
let lastLiveCacheTime = 0;
const pastTicksCache = new Map();
const loggedDatesCache = new Map();
const historicalCache = new Map();

// Start HTTP server for Render health checks and secure API proxy endpoints
const PORT = process.env.PORT || 10000;
http.createServer(async (req, res) => {
    // Add CORS headers so Android app can request safely
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = urlModule.parse(req.url, true);
    const rawPath = parsedUrl.pathname || "";
    const path = rawPath.endsWith('/') && rawPath.length > 1 ? rawPath.slice(0, -1) : rawPath;
    const query = parsedUrl.query;

    try {
        if (path === '/api/live') {
            const list = Object.values(inMemoryOhlc);
            if (list.length > 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(list));
                return;
            }

            // Fallback if memory not yet populated: construct from lastPrices or D1
            const fallbackList = Object.keys(lastPrices).map(assetKey => ({
                asset: assetKey,
                date: getIstDateString(),
                open: lastPrices[assetKey] || 0,
                high: lastPrices[assetKey] || 0,
                low: lastPrices[assetKey] || 0,
                close: lastPrices[assetKey] || 0,
                timestamp: Date.now()
            }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(fallbackList));
        }
        else if (path === '/api/test-op') {
            const range21 = getTimestampRangeForDate("XAU_USD", "2026-08-21");
            const res21 = await queryD1(
                "SELECT CAST(price AS REAL) as price, timestamp FROM intraday_prices WHERE asset = 'XAU_USD' AND CAST(timestamp AS NUMERIC) >= ? AND CAST(timestamp AS NUMERIC) <= ? ORDER BY CAST(timestamp AS NUMERIC) ASC LIMIT 5",
                [range21.startMs, range21.endMs]
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ range21, ticks: res21.result?.[0]?.results }));
        }
        else if (path === '/api/fix-open') {
            const upsertPriceRow = async (asset, dateStr, open, high, low, close) => {
                const timestamp = Date.now();
                const checkRes = await queryD1("SELECT id FROM prices WHERE asset = ? AND date = ?", [asset, dateStr]);
                const rows = checkRes.result?.[0]?.results || [];
                if (rows.length > 0) {
                    await queryD1(
                        "UPDATE prices SET open = ?, high = ?, low = ?, close = ?, timestamp = ? WHERE id = ?",
                        [open, high, low, close, timestamp, rows[0].id]
                    );
                } else {
                    await queryD1(
                        "INSERT INTO prices (asset, date, open, high, low, close, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        [asset, dateStr, open, high, low, close, timestamp]
                    );
                }
            };

            // XAU_USD
            await upsertPriceRow('XAU_USD', '2026-08-21', 4521.45, 4632.55, 4509.85, 4603.30);
            await upsertPriceRow('XAU_USD', '2026-08-20', 4522.65, 4540.80, 4451.10, 4519.20);
            await upsertPriceRow('XAU_USD', '2026-08-19', 4333.85, 4525.00, 4325.75, 4522.65);

            // 2026-08-24 Exact Tick Log OHLC
            await queryD1("UPDATE prices SET open = 167205, high = 168728, low = 167024 WHERE asset = 'GOLD_999_GST' AND date = '2026-08-24'");
            await queryD1("UPDATE prices SET open = 163165, high = 164774, low = 162957 WHERE asset = 'GOLD_MCX' AND date = '2026-08-24'");
            await queryD1("UPDATE prices SET open = 245439, high = 248799, low = 243699 WHERE asset = 'SILVER_MCX' AND date = '2026-08-24'");
            await upsertPriceRow('GOLD_999_GST', '2026-08-24', 167205, 168728, 167024, 167061);
            await upsertPriceRow('GOLD_MCX', '2026-08-24', 163165, 164774, 162957, 163111);
            await upsertPriceRow('SILVER_MCX', '2026-08-24', 245439, 248799, 243699, 244141);

            // GOLD_MCX
            await upsertPriceRow('GOLD_MCX', '2026-08-21', 159878, 162680, 159689, 162460);
            await upsertPriceRow('GOLD_MCX', '2026-08-20', 158286, 160009, 157059, 159537);
            await upsertPriceRow('GOLD_MCX', '2026-08-19', 154136, 158235, 153410, 158075);
            await upsertPriceRow('GOLD_MCX', '2026-08-18', 155388, 155732, 154150, 154284);

            // SILVER_MCX
            await upsertPriceRow('SILVER_MCX', '2026-08-21', 244939, 248118, 244380, 246754);
            await upsertPriceRow('SILVER_MCX', '2026-08-20', 240017, 244997, 235702, 243299);
            await upsertPriceRow('SILVER_MCX', '2026-08-19', 230300, 237300, 227999, 236780);
            await upsertPriceRow('SILVER_MCX', '2026-08-18', 236173, 236247, 231422, 232300);

            // GOLD_999_GST
            await upsertPriceRow('GOLD_999_GST', '2026-08-21', 163778, 166630, 163589, 166410);
            await upsertPriceRow('GOLD_999_GST', '2026-08-20', 162186, 163909, 160959, 163437);
            await upsertPriceRow('GOLD_999_GST', '2026-08-19', 157986, 162135, 157310, 161975);
            await upsertPriceRow('GOLD_999_GST', '2026-08-18', 159238, 159582, 158000, 158134);

            const updated = await queryD1("SELECT asset, date, open, high, low, close FROM prices WHERE date IN ('2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22')");
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(updated.result?.[0]?.results || []));
        }
        else if (path === '/api/debug-sync') {
            await syncHarikalaBroadcast();
            const dbRes = await queryD1(
                "SELECT * FROM prices WHERE date = ?",
                [getIstDateString()]
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(dbRes));
        }
        else if (path === '/api/dedupe') {
            await deduplicateD1PricesTable();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Deduplicated D1 prices table!' }));
        }
        else if (path === '/api/historical') {
            const asset = query.asset;
            const now = Date.now();
            const cached = historicalCache.get(asset);
            if (cached && (now - cached.time) < 600000) { // 10 minutes cache
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(cached.json);
                return;
            }

            const dbRes = await queryD1(
                "SELECT date, open, high, low, close, timestamp FROM prices WHERE asset = ? ORDER BY date DESC, timestamp DESC",
                [asset]
            );
            let rawResults = dbRes.result?.[0]?.results || [];
            
            // Deduplicate by date to guarantee 1 single row per date
            const dateMap = new Map();
            for (const r of rawResults) {
                if (!dateMap.has(r.date)) {
                    dateMap.set(r.date, r);
                }
            }
            let results = Array.from(dateMap.values());

            if (asset === "XAU_USD") {
                results = results.map(r => {
                    if (r.date === "2026-08-21") return { ...r, open: 4521.45 };
                    if (r.date === "2026-08-20") return { ...r, open: 4522.65 };
                    if (r.date === "2026-08-19") return { ...r, open: 4333.85 };
                    return r;
                });
            }
            const jsonStr = JSON.stringify(results);
            historicalCache.set(asset, { time: now, json: jsonStr });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(jsonStr);
        }
        else if (path === '/api/logged-dates') {
            const asset = query.asset;
            const now = Date.now();
            const cached = loggedDatesCache.get(asset);
            if (cached && (now - cached.time) < 3600000) { // 1 hour cache
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(cached.json);
                return;
            }

            try {
                // Query prices table directly (reads ONLY ~50 rows instead of scanning 500,000+ ticks in intraday_prices!)
                const dbRes = await queryD1(
                    "SELECT DISTINCT date FROM prices WHERE asset = ? ORDER BY date DESC",
                    [asset]
                );
                const results = dbRes.result?.[0]?.results || [];
                const datesList = results.map(r => r.date).filter(Boolean);

                const todayStr = getIstDateString();
                if (!datesList.includes(todayStr)) {
                    datesList.unshift(todayStr);
                }

                const jsonStr = JSON.stringify(datesList);
                loggedDatesCache.set(asset, { time: now, json: jsonStr });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(jsonStr);
            } catch (err) {
                const fallback = [getIstDateString()];
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(fallback));
            }
        }
        else if (path === '/api/ticks') {
            const asset = query.asset;
            const date = query.date; // YYYY-MM-DD
            const range = getTimestampRangeForDate(asset, date);
            if (!range) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Invalid date format" }));
                return;
            }

            const todayAssetDate = getAssetDateStringForTimestamp(asset, Date.now());
            const isToday = (date === todayAssetDate || date === getIstDateString() || date === getSpotAssetDateString());

            // 1. If requested date is today, ALWAYS SERVE DIRECTLY FROM RAM (0 D1 READS!)
            if (isToday) {
                const ticks = inMemoryTicks[asset] || [];
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(ticks));
                return;
            }

            // 2. If it's a past date and cached in RAM, SERVE DIRECTLY FROM RAM (0 D1 READS!)
            const cacheKey = `${asset}_${date}`;
            if (pastTicksCache.has(cacheKey)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(pastTicksCache.get(cacheKey));
                return;
            }

            // 3. Otherwise query D1 once for past date (safe try/catch fallback)
            try {
                const dbRes = await queryD1(
                    "SELECT timestamp, price FROM intraday_prices WHERE asset = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC",
                    [asset, range.startMs, range.endMs]
                );
                const results = dbRes.result?.[0]?.results || [];
                const jsonStr = JSON.stringify(results);
                pastTicksCache.set(cacheKey, jsonStr);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(jsonStr);
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([]));
            }
        }
        else if (path === '/api/d1-status') {
            try {
                const testRes = await queryD1("SELECT COUNT(*) as total_prices FROM prices");
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: "ACTIVE_AND_HEALTHY",
                    limitExceeded: false,
                    message: "Cloudflare D1 is completely healthy, within limits, and accepting queries.",
                    inMemoryTicks: Object.keys(inMemoryTicks).reduce((acc, k) => { acc[k] = inMemoryTicks[k]?.length || 0; return acc; }, {})
                }));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: "LIMIT_EXCEEDED_OR_ERROR",
                    limitExceeded: true,
                    error: err.message
                }));
            }
        }
        else if (path === '/api/clean-old-data') {
            logDebug("[MAINTENANCE] Cleaning all historical summaries before today...");
            const todayStr = getIstDateString();
            const delPrices = await queryD1(
                "DELETE FROM prices WHERE date < ?",
                [todayStr]
            );
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true, 
                message: "All previous days' historical summaries deleted successfully. Only today's live data is kept. Live ticks are preserved.", 
                delPricesResult: delPrices, 
                delTicksResult: { message: "Tick deletion is disabled. All live logs are kept forever." }
            }));
        }
        else if (path === '/api/recalculate-ohlc') {
            try {
                await recalculateAllOHLCFromTicks();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: "Recalculated all OHLC from ticks for all 5 assets!" }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        }
        else if (path === '/api/debug-logs') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(debugLogs));
        }
        else if (path === '/api/debug-db') {
            const dbRes = await queryD1("SELECT * FROM intraday_prices ORDER BY timestamp DESC LIMIT 20");
            const results = dbRes.result?.[0]?.results || [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
        }
        else if (path === '/whatsapp-qr') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>WhatsApp Web Integration</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 24px; background-color: #f9fafb; color: #111827; }
                        .card { max-width: 400px; margin: 0 auto; background: white; border-radius: 20px; padding: 28px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.08); border: 1px solid #e5e7eb; }
                        .qr-box { display: inline-block; padding: 12px; background: white; border: 4px solid #10b981; border-radius: 16px; margin: 16px 0; }
                        img { width: 250px; height: 250px; display: block; border-radius: 8px; }
                        .status { font-weight: 600; font-size: 14px; color: #059669; }
                        .btn-red { background: #dc2626; color: white; border: none; padding: 12px 20px; border-radius: 10px; font-weight: bold; cursor: pointer; font-size: 14px; transition: background 0.2s; }
                        .btn-red:hover { background: #b91c1c; }
                        .btn-red:disabled { background: #9ca3af; cursor: not-allowed; }
                    </style>
                </head>
                <body>
                    <div class="card" id="mainCard">
                        <h2 id="cardTitle" style="margin-top:0; color:#1f2937;">Connect WhatsApp</h2>
                        <p id="cardSub" style="color:#6b7280; font-size:13.5px; line-height:1.4;">Open WhatsApp on phone &gt; Settings/Menu &gt; Linked Devices &gt; Link a Device</p>
                        
                        <div class="qr-box" id="qrContainer">
                            <img id="qrImg" src="" alt="Loading QR Code..." />
                        </div>
                        
                        <p class="status" id="statusText">Generating Live QR Code...</p>
                        
                        <div style="margin-top: 20px;" id="btnContainer">
                            <button onclick="resetWaSession()" class="btn-red" id="actionBtn">🔄 Generate Fresh QR Code</button>
                        </div>
                    </div>

                    <script>
                        let isResetting = false;

                        async function resetWaSession() {
                            if (isResetting) return;
                            isResetting = true;
                            const statusEl = document.getElementById('statusText');
                            const actionBtn = document.getElementById('actionBtn');
                            if (statusEl) statusEl.innerText = "Resetting session & generating new QR...";
                            if (actionBtn) {
                                actionBtn.disabled = true;
                                actionBtn.innerText = "⏳ Resetting Session...";
                            }
                            try {
                                const r = await fetch('/api/whatsapp/reset');
                                const resData = await r.json();
                                setTimeout(() => {
                                    isResetting = false;
                                    updateQr();
                                }, 2000);
                            } catch(e) {
                                isResetting = false;
                                alert("Reset failed: " + e.message);
                                if (actionBtn) {
                                    actionBtn.disabled = false;
                                    actionBtn.innerText = "🔌 Disconnect / Unlink WhatsApp";
                                }
                            }
                        }

                        async function updateQr() {
                            if (isResetting) return;
                            try {
                                const res = await fetch('/api/whatsapp/qr-data');
                                const data = await res.json();
                                
                                const titleEl = document.getElementById('cardTitle');
                                const subEl = document.getElementById('cardSub');
                                const qrContainer = document.getElementById('qrContainer');
                                const statusEl = document.getElementById('statusText');
                                const actionBtn = document.getElementById('actionBtn');
                                
                                if (data.connected) {
                                    if (titleEl) { titleEl.innerText = "✅ WhatsApp Connected!"; titleEl.style.color = "#16a34a"; }
                                    if (subEl) { subEl.innerHTML = "User: <strong>" + (data.user || 'Active User') + "</strong><br>Scheduled rate messages will auto-send to your selected target groups."; }
                                    if (qrContainer) { qrContainer.style.display = "none"; }
                                    if (statusEl) { statusEl.innerText = "Status: Connected & Active"; statusEl.style.color = "#16a34a"; }
                                    if (actionBtn) {
                                        actionBtn.disabled = false;
                                        actionBtn.innerText = "🔌 Disconnect / Unlink WhatsApp";
                                    }
                                } else if (data.qr) {
                                    if (titleEl) { titleEl.innerText = "Connect WhatsApp"; titleEl.style.color = "#1f2937"; }
                                    if (subEl) { subEl.innerText = "Open WhatsApp on phone > Settings/Menu > Linked Devices > Link a Device"; }
                                    if (qrContainer) { qrContainer.style.display = "inline-block"; }
                                    const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(data.qr);
                                    const img = document.getElementById('qrImg');
                                    if (img && img.src !== qrUrl) { img.src = qrUrl; }
                                    if (statusEl) { statusEl.innerText = "Live QR Code • Ready to Scan"; statusEl.style.color = "#059669"; }
                                    if (actionBtn) {
                                        actionBtn.disabled = false;
                                        actionBtn.innerText = "🔄 Generate Fresh QR Code";
                                    }
                                } else {
                                    if (qrContainer) { qrContainer.style.display = "inline-block"; }
                                    if (statusEl) { statusEl.innerText = "Waiting for new QR code..."; statusEl.style.color = "#6b7280"; }
                                    if (actionBtn) {
                                        actionBtn.disabled = false;
                                        actionBtn.innerText = "🔄 Generate Fresh QR Code";
                                    }
                                }
                            } catch (e) {
                                console.error(e);
                            }
                        }
                        updateQr();
                        setInterval(updateQr, 2500);
                    </script>
                </body>
                </html>
            `);
        }
        else if (path === '/api/whatsapp/reset') {
            logDebug('[WA RESET] Resetting session auth data and generating fresh QR code...');
            isWaConnected = false;
            latestQrCode = null;
            waConnectedUser = null;
            if (waReconnectTimer) {
                clearTimeout(waReconnectTimer);
                waReconnectTimer = null;
            }
            isWaInitializing = false;
            try {
                if (waSock) {
                    try {
                        waSock.ev.removeAllListeners('connection.update');
                        waSock.ev.removeAllListeners('creds.update');
                        waSock.end(undefined);
                    } catch (e) {}
                    waSock = null;
                }
                fs.rmSync(path.join(__dirname, 'auth_info_baileys'), { recursive: true, force: true });
                // Reset saved target groups on session reset
                const currCfg = loadWaConfig();
                saveWaConfig({ ...currCfg, targetGroupId: '', targetGroupIds: [] });
            } catch (e) {
                logDebug(`[WA RESET ERROR] ${e.message}`);
            }
            setTimeout(initWhatsApp, 1000);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: "WhatsApp session reset. Generating new QR code..." }));
        }
        else if (path === '/api/whatsapp/qr-data') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                connected: isWaConnected,
                user: waConnectedUser,
                qr: latestQrCode
            }));
        }
        else if (path === '/api/whatsapp/status') {
            const istInfo = getIstTimeInfo();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                connected: isWaConnected,
                user: waConnectedUser,
                hasQr: !!latestQrCode,
                istTime: istInfo.timeFormatted,
                istDate: istInfo.todayIstStr,
                isSunday: istInfo.isSunday,
                lastSentWaKey,
                config: loadWaConfig()
            }));
        }
        else if (path === '/api/whatsapp/logs') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(waSchedulerLogs));
        }
        else if (path === '/api/whatsapp/groups') {
            if (!isWaConnected || !waSock) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "WhatsApp is not connected. Scan QR code first." }));
                return;
            }
            try {
                const groupMap = await waSock.groupFetchAllParticipating();
                const activeGroupIds = new Set(Object.keys(groupMap));
                
                // Auto-purge stale target group IDs from previous WhatsApp accounts
                const currCfg = loadWaConfig();
                if (Array.isArray(currCfg.targetGroupIds) && currCfg.targetGroupIds.length > 0) {
                    const validGroupIds = currCfg.targetGroupIds.filter(id => activeGroupIds.has(id));
                    if (validGroupIds.length !== currCfg.targetGroupIds.length) {
                        logDebug(`[WA CONFIG PURGE] Purged ${currCfg.targetGroupIds.length - validGroupIds.length} stale group ID(s) from previous account.`);
                        saveWaConfig({ ...currCfg, targetGroupIds: validGroupIds, targetGroupId: validGroupIds[0] || '' });
                    }
                }

                const groupsList = Object.values(groupMap)
                    .filter(g => !g.isCommunity) // Exclude Community parent containers that cannot receive direct chat messages
                    .map(g => ({
                        id: g.id,
                        subject: g.subject || 'Unnamed Group'
                    }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(groupsList));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        }
        else if (path === '/api/whatsapp/config') {
            if (req.method === 'POST') {
                let bodyStr = '';
                req.on('data', chunk => bodyStr += chunk);
                req.on('end', () => {
                    try {
                        const newCfg = JSON.parse(bodyStr);
                        const curr = loadWaConfig();
                        const merged = { ...curr, ...newCfg };
                        saveWaConfig(merged);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, config: merged }));
                    } catch (e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(loadWaConfig()));
            }
        }
        else if (path === '/api/whatsapp/send-now') {
            try {
                const targetOverride = (query.targetGroupId && query.targetGroupId.trim().length > 0) ? query.targetGroupId.trim() : null;
                const result = await sendGoldGstRateMessage(targetOverride);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                logWa(`[WA SEND-NOW ERROR STACK] ${e.stack || e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message, stack: e.stack }));
            }
        }

        else {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Bullion D1 Sync Worker is active and running 24/7!\n');
        }
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}).listen(PORT, () => {
    console.log(`API proxy server is listening on port ${PORT}`);
});

// Create database indexes on launch to optimize queries
async function recalculateAllOHLCFromTicks() {
    try {
        logDebug("Recalculating all OHLC daily summaries from intraday ticks for all 5 assets...");
        const assets = ["XAU_USD", "XAG_USD", "GOLD_MCX", "SILVER_MCX", "GOLD_999_GST"];
        
        for (const asset of assets) {
            const dbRes = await queryD1(
                "SELECT MIN(timestamp) as min_ts, MAX(timestamp) as max_ts FROM intraday_prices WHERE asset = ?",
                [asset]
            );
            const row = dbRes.result?.[0]?.results?.[0];
            if (!row || row.min_ts === null || row.max_ts === null) continue;

            const dates = new Set();
            for (let ts = row.min_ts; ts <= row.max_ts; ts += 3600 * 1000) {
                dates.add(getAssetDateStringForTimestamp(asset, ts));
            }
            dates.add(getAssetDateStringForTimestamp(asset, row.max_ts));

            for (const dateStr of Array.from(dates).sort()) {
                const range = getTimestampRangeForDate(asset, dateStr);
                if (!range) continue;

                const ticksRes = await queryD1(
                    "SELECT CAST(price AS REAL) as price FROM intraday_prices WHERE asset = ? AND CAST(timestamp AS INTEGER) >= ? AND CAST(timestamp AS INTEGER) <= ? ORDER BY CAST(timestamp AS INTEGER) ASC",
                    [asset, range.startMs, range.endMs]
                );
                const ticks = ticksRes.result?.[0]?.results || [];
                if (ticks.length > 0) {
                    const open = ticks[0].price;
                    const close = ticks[ticks.length - 1].price;
                    let high = open;
                    let low = open;
                    ticks.forEach(t => {
                        if (t.price > high) high = t.price;
                        if (t.price < low && t.price > 0) low = t.price;
                    });
                    await saveDailySummary(asset, dateStr, open, high, low, close);
                }
            }
        }
        logDebug("[RECALC] All 5 assets' daily OHLC summaries successfully recalculated from ticks!");
    } catch (e) {
        logDebug(`Recalculate error: ${e.message}`);
    }
}

async function ensureHistoricalBaselines() {
    try {
        const timestamp = Date.now();
        const upsertPriceRow = async (asset, dateStr, open, high, low, close) => {
            const checkRes = await queryD1("SELECT id FROM prices WHERE asset = ? AND date = ?", [asset, dateStr]);
            const rows = checkRes.result?.[0]?.results || [];
            if (rows.length > 0) {
                await queryD1(
                    "UPDATE prices SET open = ?, high = ?, low = ?, close = ?, timestamp = ? WHERE id = ?",
                    [open, high, low, close, timestamp, rows[0].id]
                );
            } else {
                await queryD1(
                    "INSERT INTO prices (asset, date, open, high, low, close, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [asset, dateStr, open, high, low, close, timestamp]
                );
            }
        };

        // Spot Gold (XAU_USD)
        await upsertPriceRow('XAU_USD', '2026-08-23', 4603.30, 4621.95, 4603.30, 4621.95);
        await upsertPriceRow('XAU_USD', '2026-08-22', 4603.30, 4603.30, 4603.30, 4603.30);
        await upsertPriceRow('XAU_USD', '2026-08-21', 4521.45, 4632.55, 4509.85, 4603.30);
        await upsertPriceRow('XAU_USD', '2026-08-20', 4522.65, 4540.80, 4451.10, 4519.20);
        await upsertPriceRow('XAU_USD', '2026-08-19', 4333.85, 4525.00, 4325.75, 4522.65);

        // Spot Silver (XAG_USD)
        await upsertPriceRow('XAG_USD', '2026-08-23', 69.00, 69.24, 69.00, 69.24);
        await upsertPriceRow('XAG_USD', '2026-08-22', 69.00, 69.00, 69.00, 69.00);
        await upsertPriceRow('XAG_USD', '2026-08-21', 68.23, 70.03, 67.95, 69.00);
        await upsertPriceRow('XAG_USD', '2026-08-20', 67.16, 68.99, 65.67, 68.22);
        await upsertPriceRow('XAG_USD', '2026-08-19', 63.35, 67.17, 62.59, 67.17);

        // GOLD_MCX
        await upsertPriceRow('GOLD_MCX', '2026-08-23', 162460, 162460, 162460, 162460);
        await upsertPriceRow('GOLD_MCX', '2026-08-22', 162460, 162460, 162460, 162460);
        await upsertPriceRow('GOLD_MCX', '2026-08-21', 159878, 162680, 159689, 162460);
        await upsertPriceRow('GOLD_MCX', '2026-08-20', 158286, 160009, 157059, 159537);
        await upsertPriceRow('GOLD_MCX', '2026-08-19', 154136, 158235, 153410, 158075);
        await upsertPriceRow('GOLD_MCX', '2026-08-18', 155388, 155732, 154150, 154284);

        // SILVER_MCX
        await upsertPriceRow('SILVER_MCX', '2026-08-23', 246754, 246754, 246754, 246754);
        await upsertPriceRow('SILVER_MCX', '2026-08-22', 246754, 246754, 246754, 246754);
        await upsertPriceRow('SILVER_MCX', '2026-08-21', 244939, 248118, 244380, 246754);
        await upsertPriceRow('SILVER_MCX', '2026-08-20', 240017, 244997, 235702, 243299);
        await upsertPriceRow('SILVER_MCX', '2026-08-19', 230300, 237300, 227999, 236780);
        await upsertPriceRow('SILVER_MCX', '2026-08-18', 236173, 236247, 231422, 232300);

        // GOLD_999_GST
        await upsertPriceRow('GOLD_999_GST', '2026-08-23', 166500, 166500, 166500, 166500);
        await upsertPriceRow('GOLD_999_GST', '2026-08-22', 166410, 166600, 166150, 166500);
        await upsertPriceRow('GOLD_999_GST', '2026-08-21', 163778, 166630, 163589, 166410);
        await upsertPriceRow('GOLD_999_GST', '2026-08-20', 162186, 163909, 160959, 163437);
        await upsertPriceRow('GOLD_999_GST', '2026-08-19', 157986, 162135, 157310, 161975);
        await upsertPriceRow('GOLD_999_GST', '2026-08-18', 159238, 159582, 158000, 158134);

        logDebug("[BASELINES] All 5 assets' historical baselines ensured.");
    } catch (e) {
        logDebug(`[BASELINES ERROR] ${e.message}`);
    }
}

async function deduplicateD1PricesTable() {
    try {
        logDebug("Deduplicating prices table in Cloud D1...");
        const assets = ["XAU_USD", "XAG_USD", "GOLD_MCX", "SILVER_MCX", "GOLD_999_GST"];
        for (const asset of assets) {
            const res = await queryD1(
                "SELECT id, date FROM prices WHERE asset = ? ORDER BY id DESC",
                [asset]
            );
            const rows = res.result?.[0]?.results || [];
            const seenDates = new Set();
            const idsToDelete = [];

            for (const row of rows) {
                if (seenDates.has(row.date)) {
                    idsToDelete.push(row.id);
                } else {
                    seenDates.add(row.date);
                }
            }

            for (const id of idsToDelete) {
                await queryD1("DELETE FROM prices WHERE id = ?", [id]);
            }
            if (idsToDelete.length > 0) {
                logDebug(`[DEDUPE] Deleted ${idsToDelete.length} duplicate rows for ${asset}`);
            }
        }
    } catch (e) {
        logDebug(`[DEDUPE ERROR] ${e.message}`);
    }
}

// Create database indexes on launch to optimize queries
async function initDatabaseIndexes() {
    try {
        logDebug("Initializing D1 Database indexes...");
        await queryD1("CREATE INDEX IF NOT EXISTS idx_intraday_prices_asset_timestamp ON intraday_prices(asset, timestamp)");
        await queryD1("CREATE INDEX IF NOT EXISTS idx_prices_asset_date ON prices(asset, date)");
        await ensureHistoricalBaselines();
    } catch (e) {
        logDebug(`[INDEX INIT ERROR] Failed to create database indexes: ${e.message}`);
    }
}

// Run immediately on launch
(async () => {
    await initDatabaseIndexes();
    initWhatsApp();
    runSyncCycle();
})();

// Run every 10 seconds
setInterval(runSyncCycle, 10000);
