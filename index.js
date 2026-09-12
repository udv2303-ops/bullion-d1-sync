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
function isUsDst(date = new Date()) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        timeZoneName: 'short'
    });
    const parts = dtf.formatToParts(date);
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    // In US Eastern: EDT = Daylight Saving Time, EST = Standard Time
    return tzPart ? tzPart.value === 'EDT' : true;
}

// Calculate the exact CME Globex trade date (YYYY-MM-DD) for any given timestamp
function getComexTradeDate(dateObj = new Date()) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: 'numeric',
        minute: 'numeric'
    });
    const parts = dtf.formatToParts(dateObj);
    let weekday = '', year = 0, month = 0, day = 0, hour = 0, minute = 0;
    for (const { type, value } of parts) {
        if (type === 'weekday') weekday = value;
        if (type === 'year') year = parseInt(value, 10);
        if (type === 'month') month = parseInt(value, 10);
        if (type === 'day') day = parseInt(value, 10);
        if (type === 'hour') hour = parseInt(value, 10);
        if (type === 'minute') minute = parseInt(value, 10);
    }

    const nyDate = new Date(Date.UTC(year, month - 1, day));

    if (weekday === 'Sun') {
        if (hour >= 18) {
            // Sunday evening (18:00 ET) opens the Monday trading session
            nyDate.setUTCDate(nyDate.getUTCDate() + 1);
        } else {
            // Sunday before 18:00 is weekend; the last completed trade date was Friday (-2 days)
            nyDate.setUTCDate(nyDate.getUTCDate() - 2);
        }
    } else if (weekday === 'Sat') {
        // Saturday is weekend; belongs to Friday's completed trade date (-1 day)
        nyDate.setUTCDate(nyDate.getUTCDate() - 1);
    } else if (weekday === 'Fri') {
        // Friday is Friday trade date
    } else {
        // Monday through Thursday: After 18:00 ET, trading advances to the next day's trade date
        if (hour >= 18) {
            nyDate.setUTCDate(nyDate.getUTCDate() + 1);
        }
    }

    const resY = nyDate.getUTCFullYear();
    const resM = String(nyDate.getUTCMonth() + 1).padStart(2, '0');
    const resD = String(nyDate.getUTCDate()).padStart(2, '0');
    return `${resY}-${resM}-${resD}`;
}

// Get date string for an asset (CME trade date for Spot assets, or IST date for others)
function getAssetDateStringForTimestamp(asset, timestampMs) {
    if (asset === "XAU_USD" || asset === "XAG_USD") {
        return getComexTradeDate(new Date(timestampMs));
    } else {
        const istTimeMs = timestampMs + (5.5 * 60 * 60 * 1000);
        const istDate = new Date(istTimeMs);
        return istDate.toISOString().split('T')[0];
    }
}

// Get shifted date string for spot gold/silver based on current CME Globex session
function getSpotAssetDateString() {
    return getComexTradeDate(new Date());
}

// Check if MCX Bullion market is actively open right now (09:00:10 AM to 11:50:00 PM IST, 7 days a week)
function isMcxMarketOpenNow() {
    const d = new Date();
    const istTime = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
    const secondsSinceMidnight = istTime.getUTCHours() * 3600 + istTime.getUTCMinutes() * 60 + istTime.getUTCSeconds();
    const startSeconds = 9 * 3600 + 10; // 09:00:10 AM IST
    const endSeconds = 23 * 3600 + 50 * 60; // 11:50:00 PM IST
    return secondsSinceMidnight >= startSeconds && secondsSinceMidnight <= endSeconds;
}

// Check if International CME Globex Spot Gold / Silver market is actively open right now
function isSpotMarketOpenNow(dateObj = new Date()) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric'
    });
    const parts = dtf.formatToParts(dateObj);
    let weekday = '', hour = 0, minute = 0;
    for (const { type, value } of parts) {
        if (type === 'weekday') weekday = value;
        if (type === 'hour') hour = parseInt(value, 10);
        if (type === 'minute') minute = parseInt(value, 10);
    }
    const totalMinutes = hour * 60 + minute;

    // Saturday: completely closed all day
    if (weekday === 'Sat') return false;

    // Sunday: closed until 18:00 ET (6:00 PM)
    if (weekday === 'Sun') {
        return totalMinutes >= 18 * 60;
    }

    // Friday: closes at 17:00 ET (5:00 PM) for the weekend
    if (weekday === 'Fri') {
        return totalMinutes < 17 * 60;
    }

    // Monday - Thursday: closed during 1-hour maintenance break (17:00 - 18:00 ET)
    const isDailyBreak = (totalMinutes >= 17 * 60 && totalMinutes < 18 * 60);
    return !isDailyBreak;
}

// Check if Indian GST Bullion (physical spot) market is actively open right now (09:00:10 AM to 11:50:00 PM IST, 7 days a week)
function isGstMarketOpenNow() {
    const d = new Date();
    const istTime = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
    const secondsSinceMidnight = istTime.getUTCHours() * 3600 + istTime.getUTCMinutes() * 60 + istTime.getUTCSeconds();
    const startSeconds = 9 * 3600 + 10; // 09:00:10 AM IST
    const endSeconds = 23 * 3600 + 50 * 60; // 11:50:00 PM IST
    return secondsSinceMidnight >= startSeconds && secondsSinceMidnight <= endSeconds;
}

// Check if an asset's market is actively open right now
function isAssetMarketOpenNow(asset) {
    if (asset === "XAU_USD" || asset === "XAG_USD") {
        return isSpotMarketOpenNow();
    } else if (asset === "GOLD_MCX" || asset === "SILVER_MCX") {
        return isMcxMarketOpenNow();
    } else if (asset === "GOLD_999_GST") {
        return isGstMarketOpenNow();
    }
    return true;
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
        const dateForDst = new Date(midnightIstMs + 12 * 3600 * 1000);
        const dst = isUsDst(dateForDst);
        // Summer DST (EDT): Session opens 03:30:00 AM IST on dateStr, closes 02:30:00 AM IST next day (break up to 03:29:59 AM)
        // Winter EST: Session opens 04:30:00 AM IST on dateStr, closes 03:30:00 AM IST next day (break up to 04:29:59 AM)
        const openOffsetMs = dst ? (3 * 3600 + 30 * 60) * 1000 : (4 * 3600 + 30 * 60) * 1000;
        const sessionEndMs = dst ? (24 * 3600 + 3 * 3600 + 29 * 60 + 59) * 1000 : (24 * 3600 + 4 * 3600 + 29 * 60 + 59) * 1000;
        
        startMs = midnightIstMs + openOffsetMs;
        endMs = midnightIstMs + sessionEndMs;
    } else if (asset === "GOLD_MCX" || asset === "SILVER_MCX" || asset === "GOLD_999_GST") {
        // Explicit 9:00:10 AM IST to 11:55:10 PM IST session range for MCX & GST
        startMs = midnightIstMs + (9 * 3600 + 10) * 1000;
        endMs = midnightIstMs + (23 * 3600 + 55 * 60 + 10) * 1000;
    }
    
    return { startMs, endMs };
}

const inMemoryTicks = {};
const currentMinuteTicks = {};
const currentMinuteKey = {};

async function flushMinuteToD1(asset, minuteTs, ticks) {
    if (!ticks || ticks.length === 0) return;
    try {
        const jsonStr = JSON.stringify(ticks);
        // Upsert 1 single row per minute containing all 6 distinct 10-second ticks
        const upd = await queryD1(
            "UPDATE intraday_minute_ticks SET ticks_json = ? WHERE asset = ? AND minute_timestamp = ?",
            [jsonStr, asset, minuteTs]
        );
        if (upd?.result?.[0]?.meta?.changes === 0) {
            await queryD1(
                "INSERT INTO intraday_minute_ticks (asset, minute_timestamp, ticks_json) VALUES (?, ?, ?)",
                [asset, minuteTs, jsonStr]
            );
        }
        logDebug(`[MINUTE D1] Flushed ${asset} at ${new Date(minuteTs).toLocaleTimeString()} with ${ticks.length} ticks`);
    } catch (e) {
        logDebug(`[MINUTE D1 ERROR] Failed to flush minute for ${asset}: ${e.message}`);
    }
}

async function saveIntradayTick(asset, price) {
    const currentPrice = toDoubleSafe(price);
    if (currentPrice <= 0.0) return;

    // 1. Record ticks unconditionally in RAM every 10 seconds (Zero latency, live streaming for app & WhatsApp)
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

    // 2. 1-Minute Tick Bucketing for Cloudflare D1 (Active 24/7 including Saturday & Sunday):
    // Align timestamp to the start of the current minute (e.g. 12:05:00.000)
    const minuteTs = Math.floor(timestamp / 60000) * 60000;

    if (!currentMinuteTicks[asset]) {
        currentMinuteTicks[asset] = [];
        currentMinuteKey[asset] = minuteTs;
    }

    // If minute has rolled over, flush completed minute to D1 as 1 single row
    if (currentMinuteKey[asset] !== minuteTs) {
        const completedTs = currentMinuteKey[asset];
        const completedTicks = currentMinuteTicks[asset];

        currentMinuteTicks[asset] = [];
        currentMinuteKey[asset] = minuteTs;

        if (completedTicks.length > 0) {
            flushMinuteToD1(asset, completedTs, completedTicks);
        }
    }

    // Every 10-second tick is recorded as its own distinct item with its exact timestamp, even if price is same!
    currentMinuteTicks[asset].push({ timestamp, price: currentPrice });
}

const inMemoryOhlc = {};
const lastD1OhlcSync = {};

async function saveDailySummary(asset, dateStr, open, high, low, close) {
    const timestamp = Date.now();
    const isCorruptedOpen = (val) => (!val || val <= 0 || val === 4521.45 || val === 4522.65 || val === 4333.85);

    // Guard: Do not record or update daily summary if the asset's market is closed
    if ((asset === "GOLD_MCX" || asset === "SILVER_MCX") && !isMcxMarketOpenNow()) {
        return;
    }
    if (asset === "GOLD_999_GST" && !isGstMarketOpenNow()) {
        return;
    }
    if ((asset === "XAU_USD" || asset === "XAG_USD") && !isSpotMarketOpenNow()) {
        return;
    }

    // 1. ALWAYS update inMemoryOhlc immediately in RAM (Zero latency, 100% immune to D1 errors)
    if (!inMemoryOhlc[asset] || inMemoryOhlc[asset].date !== dateStr) {
        // First tick at or after 09:00:10 AM IST establishes the REAL OPEN for today
        const initialOpen = (!isCorruptedOpen(open) && open > 0) ? open : close;
        inMemoryOhlc[asset] = {
            asset,
            date: dateStr,
            open: initialOpen,
            high: Math.max(high || 0.0, initialOpen, close),
            low: (low > 0 && low < initialOpen) ? low : Math.min(initialOpen, close),
            close: close,
            timestamp: timestamp
        };
    } else {
        const cached = inMemoryOhlc[asset];
        // Open is strictly locked once set for the day - never change cached.open unless it was corrupted
        if (isCorruptedOpen(cached.open) && !isCorruptedOpen(open)) {
            cached.open = open;
        }
        cached.high = Math.max(cached.high || 0.0, high || 0.0, close);
        if (low > 0) {
            cached.low = cached.low > 0 ? Math.min(cached.low, low, close) : Math.min(low, close);
        } else {
            cached.low = cached.low > 0 ? Math.min(cached.low, close) : close;
        }
        cached.close = close;
        cached.timestamp = timestamp;
    }

    // 2. Throttled async update to D1 (once every 5 minutes / 300s per asset, active 24/7) using clean UPDATE / INSERT
    const now = Date.now();
    const lastSync = lastD1OhlcSync[asset] || 0;
    if (now - lastSync >= 300000) {
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
        
        const isMcxMarketOpen = isMcxMarketOpenNow();
        const isSpotOpen = isSpotMarketOpenNow();
        const isGstOpen = isGstMarketOpenNow();
        
        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            
            const parts = line.split("\t").map(p => p.trim());
            if (parts.length < 5) continue;
            
            const name = parts[1]; // Index 1 is the asset name
            const closeVal = toDoubleSafe(parts[3]); // Index 3 is the close/ask price
            if (closeVal <= 0.0) continue;

            const d = new Date();
            const istTime = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
            const istDay = istTime.getUTCDay(); // 0 = Sunday, 6 = Saturday
            const isWeekend = (istDay === 0 || istDay === 6);

            // On weekdays, use exchange high/low. On weekends, avoid copying Friday's exchange range; start from today's live rate!
            let highVal = parts[4] ? toDoubleSafe(parts[4]) : closeVal;
            let lowVal = parts[5] ? toDoubleSafe(parts[5]) : closeVal;
            if (isWeekend && (name === "GOLD FUTURE" || name === "SILVER FUTURE")) {
                highVal = closeVal;
                lowVal = closeVal;
            }

            // Real Open is NEVER the Bid (parts[2]). At 09:00:10 AM IST, Open is established from closeVal!
            const openVal = closeVal;
            
            if (name === "GOLD") {
                // Spot Gold
                lastPrices["XAU_USD"] = closeVal;
                if (isSpotOpen) {
                    const spotDateStr = getSpotAssetDateString();
                    await saveDailySummary("XAU_USD", spotDateStr, closeVal, closeVal, closeVal, closeVal);
                    await saveIntradayTick("XAU_USD", closeVal);
                    logDebug(`[HARIKALA-SPOT] Synced XAU_USD: ${closeVal} with date ${spotDateStr}`);
                }
            }
            else if (name === "SILVER") {
                // Spot Silver
                lastPrices["XAG_USD"] = closeVal;
                if (isSpotOpen) {
                    const spotDateStr = getSpotAssetDateString();
                    await saveDailySummary("XAG_USD", spotDateStr, closeVal, closeVal, closeVal, closeVal);
                    await saveIntradayTick("XAG_USD", closeVal);
                    logDebug(`[HARIKALA-SPOT] Synced XAG_USD: ${closeVal} with date ${spotDateStr}`);
                }
            }
            else if (name === "GOLD FUTURE") {
                // MCX Gold Future
                lastPrices["GOLD_MCX"] = closeVal;
                if (isMcxMarketOpen) {
                    await saveDailySummary("GOLD_MCX", dateStr, openVal, highVal, lowVal, closeVal);
                    await saveIntradayTick("GOLD_MCX", closeVal);
                    logDebug(`[HARIKALA-MCX] Synced GOLD_MCX: ${closeVal}`);
                }
            }
            else if (name === "SILVER FUTURE") {
                // MCX Silver Future
                lastPrices["SILVER_MCX"] = closeVal;
                if (isMcxMarketOpen) {
                    await saveDailySummary("SILVER_MCX", dateStr, openVal, highVal, lowVal, closeVal);
                    await saveIntradayTick("SILVER_MCX", closeVal);
                    logDebug(`[HARIKALA-MCX] Synced SILVER_MCX: ${closeVal}`);
                }
            }
            else if (name === "GOLD 999 IMP WITH GST (Today)") {
                // GST Gold
                lastPrices["GOLD_999_GST"] = closeVal;
                if (isGstOpen) {
                    await saveDailySummary("GOLD_999_GST", dateStr, openVal, highVal, lowVal, closeVal);
                    await saveIntradayTick("GOLD_999_GST", closeVal);
                    logDebug(`[HARIKALA-GST] Synced GOLD_999_GST: ${closeVal}`);
                }
            }
        }
    } catch (e) {
        logDebug(`Error syncing Harikala Broadcast: ${e.message}`);
    }
}

let lastProcessedMcxDate = getIstDateString();
let lastProcessedSpotDate = getSpotAssetDateString();

async function autoArchiveDay(completedDate, assetList = null) {
    const assets = assetList || ["GOLD_MCX", "SILVER_MCX", "GOLD_999_GST", "XAU_USD", "XAG_USD"];
    logDebug(`[AUTO-ARCHIVE] Consolidating day ${completedDate} for assets: ${assets.join(', ')}...`);
    for (const asset of assets) {
        try {
            const isSpot = (asset === "XAU_USD" || asset === "XAG_USD");
            // If spot asset and date is weekend (Sat/Sun), do not archive or create weekend rows
            if (isSpot) {
                const dayOfWeek = new Date(completedDate + 'T12:00:00Z').getUTCDay();
                if (dayOfWeek === 0 || dayOfWeek === 6) {
                    continue;
                }
            }

            // Check if already archived
            const checkRes = await queryD1(
                "SELECT id, ticks_json FROM daily_tick_archives WHERE asset = ? AND date = ? LIMIT 1",
                [asset, completedDate]
            );
            let dayTicks = [];
            const existingRow = checkRes?.result?.[0]?.results?.[0];
            if (existingRow && existingRow.ticks_json) {
                try {
                    dayTicks = JSON.parse(existingRow.ticks_json);
                } catch (e) {}
            }

            const range = getTimestampRangeForDate(asset, completedDate);
            if (!range && dayTicks.length === 0) continue;

            // For spot assets, always look for post-midnight ticks in intraday_minute_ticks even if dayTicks has rows
            if (range && (dayTicks.length === 0 || isSpot)) {
                // 1. Gather ticks from intraday_minute_ticks
                const bucketRes = await queryD1(
                    "SELECT minute_timestamp, ticks_json FROM intraday_minute_ticks WHERE asset = ? AND minute_timestamp >= ? AND minute_timestamp <= ? ORDER BY minute_timestamp ASC",
                    [asset, range.startMs, range.endMs]
                );
                const bucketRows = bucketRes.result?.[0]?.results || [];
                const seenTs = new Set(dayTicks.map(t => t.timestamp));
                for (const row of bucketRows) {
                    try {
                        const parsed = JSON.parse(row.ticks_json);
                        if (Array.isArray(parsed)) {
                            for (const t of parsed) {
                                if (t && !seenTs.has(t.timestamp)) {
                                    dayTicks.push(t);
                                    seenTs.add(t.timestamp);
                                }
                            }
                        }
                    } catch (e) {}
                }

                // 2. Fallback to inMemoryTicks if needed
                if (inMemoryTicks[asset]) {
                    const memInRange = inMemoryTicks[asset].filter(t => t.timestamp >= range.startMs && t.timestamp <= range.endMs);
                    for (const t of memInRange) {
                        if (t && !seenTs.has(t.timestamp)) {
                            dayTicks.push(t);
                            seenTs.add(t.timestamp);
                        }
                    }
                }

                // 3. Fallback to legacy intraday_prices table if still empty
                if (dayTicks.length === 0) {
                    const legacyRes = await queryD1(
                        "SELECT timestamp, price FROM intraday_prices WHERE asset = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC",
                        [asset, range.startMs, range.endMs]
                    );
                    const legRows = legacyRes.result?.[0]?.results || [];
                    for (const r of legRows) {
                        const ts = Number(r.timestamp);
                        if (!seenTs.has(ts)) {
                            dayTicks.push({ timestamp: ts, price: Number(r.price) });
                            seenTs.add(ts);
                        }
                    }
                }

                if (dayTicks.length > 0) {
                    dayTicks.sort((a, b) => a.timestamp - b.timestamp);
                    const jsonStr = JSON.stringify(dayTicks);
                    await queryD1(
                        "INSERT OR REPLACE INTO daily_tick_archives (asset, date, ticks_json) VALUES (?, ?, ?)",
                        [asset, completedDate, jsonStr]
                    );
                    logDebug(`[AUTO-ARCHIVE] Successfully consolidated ${dayTicks.length} ticks for ${asset} on ${completedDate} into 1 single row!`);

                    // Clean up intermediate minute ticks for completed past day to save database storage
                    await queryD1(
                        "DELETE FROM intraday_minute_ticks WHERE asset = ? AND minute_timestamp >= ? AND minute_timestamp <= ?",
                        [asset, range.startMs, range.endMs]
                    );
                }
            }

            // Calculate and synchronize final daily OHLC to prices table directly from ticks
            const validTicks = dayTicks.filter(t => t && Number(t.price) > 0 && !isNaN(Number(t.price)));
            if (validTicks.length > 0) {
                validTicks.sort((a, b) => a.timestamp - b.timestamp);
                const open = Number(validTicks[0].price);
                const close = Number(validTicks[validTicks.length - 1].price);
                let high = open;
                let low = open;
                for (let i = 0; i < validTicks.length; i++) {
                    const p = Number(validTicks[i].price);
                    if (p > high) high = p;
                    if (p < low && p > 0) low = p;
                }
                const lastTs = validTicks[validTicks.length - 1].timestamp || Date.now();
                const updRes = await queryD1(
                    "UPDATE prices SET open = ?, high = ?, low = ?, close = ?, timestamp = ? WHERE asset = ? AND date = ?",
                    [open, high, low, close, lastTs, asset, completedDate]
                );
                if (updRes?.result?.[0]?.meta?.changes === 0) {
                    await queryD1(
                        "INSERT INTO prices (asset, date, open, high, low, close, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        [asset, completedDate, open, high, low, close, lastTs]
                    );
                }
                historicalCache.delete(asset);
                loggedDatesCache.delete(asset);
                logDebug(`[AUTO-ARCHIVE OHLC] Synchronized prices table for ${asset} on ${completedDate}: O=${open}, H=${high}, L=${low}, C=${close}`);
            }
        } catch (err) {
            logDebug(`[AUTO-ARCHIVE ERROR] ${asset} on ${completedDate}: ${err.message}`);
        }
    }
}

// Main sync scheduling loop
async function runSyncCycle() {
    logDebug(`[SYNC CYCLE START]`);

    // 1. MCX & Indian GST Midnight Rollover Check (00:00:00 IST)
    const currentIstDate = getIstDateString();
    if (currentIstDate !== lastProcessedMcxDate) {
        const completedDate = lastProcessedMcxDate;
        lastProcessedMcxDate = currentIstDate;
        logDebug(`[MCX MIDNIGHT ROLLOVER] Consolidating completed MCX day ${completedDate}...`);
        for (const asset of ["GOLD_MCX", "SILVER_MCX", "GOLD_999_GST"]) {
            if (currentMinuteTicks[asset] && currentMinuteTicks[asset].length > 0) {
                await flushMinuteToD1(asset, currentMinuteKey[asset], currentMinuteTicks[asset]);
                currentMinuteTicks[asset] = [];
            }
        }
        await autoArchiveDay(completedDate, ["GOLD_MCX", "SILVER_MCX", "GOLD_999_GST"]);
    }

    // 2. COMEX Spot Bullion Session Rollover Check (03:30 AM Summer / 04:30 AM Winter IST, or Monday open)
    const currentSpotDate = getSpotAssetDateString();
    if (currentSpotDate !== lastProcessedSpotDate) {
        const completedSpotDate = lastProcessedSpotDate;
        lastProcessedSpotDate = currentSpotDate;
        logDebug(`[COMEX SESSION ROLLOVER] Consolidating completed COMEX session ${completedSpotDate}...`);
        for (const asset of ["XAU_USD", "XAG_USD"]) {
            if (currentMinuteTicks[asset] && currentMinuteTicks[asset].length > 0) {
                await flushMinuteToD1(asset, currentMinuteKey[asset], currentMinuteTicks[asset]);
                currentMinuteTicks[asset] = [];
            }
        }
        await autoArchiveDay(completedSpotDate, ["XAU_USD", "XAG_USD"]);
    }

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
    
    // Fetch latest prices for selected scripts (RAM FIRST - 0 D1 reads, instantaneous live rate!)
    const pricesMap = {};
    for (const script of selectedScripts) {
        let price = (inMemoryOhlc[script] && inMemoryOhlc[script].close > 0)
            ? inMemoryOhlc[script].close
            : (lastPrices[script] || 0.0);

        // Fallback to D1 only if server just booted and RAM is empty
        if (price <= 0.0) {
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

                const isSpot = (asset === "XAU_USD" || asset === "XAG_USD");
                if (isSpot) {
                    const spotDateStr = getSpotAssetDateString();
                    if (isSpotMarketOpenNow() && !datesList.includes(spotDateStr)) {
                        datesList.unshift(spotDateStr);
                    }
                } else {
                    const todayStr = getIstDateString();
                    if (!datesList.includes(todayStr)) {
                        datesList.unshift(todayStr);
                    }
                }

                const jsonStr = JSON.stringify(datesList);
                loggedDatesCache.set(asset, { time: now, json: jsonStr });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(jsonStr);
            } catch (err) {
                const fallback = (asset === "XAU_USD" || asset === "XAG_USD") ? [getSpotAssetDateString()] : [getIstDateString()];
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

            const isSpot = (asset === "XAU_USD" || asset === "XAG_USD");
            const todayAssetDate = getAssetDateStringForTimestamp(asset, Date.now());
            const isToday = isSpot
                ? (isSpotMarketOpenNow() && (date === todayAssetDate || date === getSpotAssetDateString()))
                : (date === todayAssetDate || date === getIstDateString());

            // 1. If requested date is today, SERVE DIRECTLY FROM RAM (or load from D1 minute buckets if server recently started)
            if (isToday) {
                let rawTicks = inMemoryTicks[asset] || [];
                let ticks = rawTicks.filter(t => t.timestamp >= range.startMs && t.timestamp <= range.endMs);
                
                // If RAM has very few ticks (e.g. server recently restarted), fetch today's stored ticks from D1
                if (ticks.length < 50) {
                    try {
                        const bucketRes = await queryD1(
                            "SELECT minute_timestamp, ticks_json FROM intraday_minute_ticks WHERE asset = ? AND minute_timestamp >= ? AND minute_timestamp <= ? ORDER BY minute_timestamp DESC",
                            [asset, range.startMs, range.endMs]
                        );
                        const bucketRows = bucketRes.result?.[0]?.results || [];
                        const loadedTicks = [];
                        for (const row of bucketRows) {
                            try {
                                const parsed = JSON.parse(row.ticks_json);
                                if (Array.isArray(parsed)) {
                                    loadedTicks.push(...parsed);
                                }
                            } catch (e) {}
                        }
                        if (loadedTicks.length < 50) {
                            const dbRes = await queryD1(
                                "SELECT timestamp, price FROM intraday_prices WHERE asset = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC",
                                [asset, range.startMs, range.endMs]
                            );
                            const legRows = dbRes.result?.[0]?.results || [];
                            for (const r of legRows) {
                                loadedTicks.push({ timestamp: Number(r.timestamp), price: Number(r.price) });
                            }
                        }
                        if (loadedTicks.length > 0) {
                            const existingTs = new Set(ticks.map(t => t.timestamp));
                            for (const t of loadedTicks) {
                                if (!existingTs.has(t.timestamp)) {
                                    ticks.push(t);
                                }
                            }
                            ticks.sort((a, b) => b.timestamp - a.timestamp);
                            inMemoryTicks[asset] = ticks.slice(0, 10000);
                        }
                    } catch (e) {}
                }

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

            // 3. Otherwise query D1 once for past date:
            try {
                let results = [];

                // 3a. Check daily_tick_archives first (READS ONLY 1 SINGLE ROW FROM D1!)
                const archiveRes = await queryD1(
                    "SELECT ticks_json FROM daily_tick_archives WHERE asset = ? AND date = ? LIMIT 1",
                    [asset, date]
                );
                const archiveRow = archiveRes.result?.[0]?.results?.[0];
                if (archiveRow && archiveRow.ticks_json) {
                    try {
                        results = JSON.parse(archiveRow.ticks_json);
                        logDebug(`[ARCHIVE READ] Served ${asset} for ${date} directly from daily_tick_archives (1 single row read!)`);
                    } catch (e) {}
                }

                // 3b. If not yet archived, query 1-minute buckets
                if (results.length === 0) {
                    const bucketRes = await queryD1(
                        "SELECT minute_timestamp, ticks_json FROM intraday_minute_ticks WHERE asset = ? AND minute_timestamp >= ? AND minute_timestamp <= ? ORDER BY minute_timestamp DESC",
                        [asset, range.startMs, range.endMs]
                    );
                    const bucketRows = bucketRes.result?.[0]?.results || [];
                    if (bucketRows.length > 0) {
                        for (const row of bucketRows) {
                            try {
                                const parsed = JSON.parse(row.ticks_json);
                                if (Array.isArray(parsed)) {
                                    for (let i = parsed.length - 1; i >= 0; i--) {
                                        results.push(parsed[i]);
                                    }
                                }
                            } catch (err) {}
                        }
                    } else {
                        // Fallback to legacy intraday_prices table
                        const dbRes = await queryD1(
                            "SELECT timestamp, price FROM intraday_prices WHERE asset = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC",
                            [asset, range.startMs, range.endMs]
                        );
                        results = dbRes.result?.[0]?.results || [];
                    }

                    // 3c. AUTO-ARCHIVE: Once assembled, save whole day as 1 single row for future lightning-fast 1-row reads!
                    if (results.length > 0) {
                        try {
                            const jsonToArchive = JSON.stringify(results);
                            await queryD1(
                                "INSERT OR REPLACE INTO daily_tick_archives (asset, date, ticks_json) VALUES (?, ?, ?)",
                                [asset, date, jsonToArchive]
                            );
                            logDebug(`[AUTO-ARCHIVE] Archived ${results.length} ticks for ${asset} on ${date} into 1 single row`);
                        } catch (e) {
                            // Safe ignore
                        }
                    }
                }

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
        else if (path === '/api/recalculate-ohlc' || path === '/api/sync-historical-from-ticks') {
            try {
                const summary = await recalculateAllOHLCFromTicks();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    message: "Recalculated and synchronized all historical OHLC prices from recorded intraday ticks!", 
                    summary 
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        }
        else if (path === '/api/restore-sep-dates') {
            try {
                await ensureHistoricalBaselines();
                historicalCache.clear();
                loggedDatesCache.clear();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: "Sep 2 and Sep 4 dates restored successfully!" }));
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

// Remove any phantom weekend rows created for COMEX Spot assets (since CME Globex is closed on weekends)
async function cleanupWeekendComexRows() {
    try {
        const resPrices = await queryD1(
            "DELETE FROM prices WHERE asset IN ('XAU_USD', 'XAG_USD') AND (date = '2026-09-12' OR strftime('%w', date) IN ('0', '6'))"
        );
        const resArch = await queryD1(
            "DELETE FROM daily_tick_archives WHERE asset IN ('XAU_USD', 'XAG_USD') AND (date = '2026-09-12' OR strftime('%w', date) IN ('0', '6'))"
        );
        historicalCache.delete("XAU_USD");
        historicalCache.delete("XAG_USD");
        loggedDatesCache.delete("XAU_USD");
        loggedDatesCache.delete("XAG_USD");
        const pCnt = resPrices?.result?.[0]?.meta?.changes || 0;
        const aCnt = resArch?.result?.[0]?.meta?.changes || 0;
        logDebug(`[CLEANUP COMEX] Purged weekend rows: prices=${pCnt}, archives=${aCnt}`);
    } catch (e) {
        logDebug(`[CLEANUP COMEX ERROR] ${e.message}`);
    }
}

// Calculate and synchronize true daily OHLC from recorded intraday ticks for all assets
async function recalculateAllOHLCFromTicks() {
    try {
        logDebug("[RECALC] Starting full recalculation of Historical OHLC from real ticks...");
        await cleanupWeekendComexRows();
        const assets = ["GOLD_MCX", "SILVER_MCX", "GOLD_999_GST", "XAU_USD", "XAG_USD"];
        const summary = {};

        for (const asset of assets) {
            summary[asset] = { updatedDates: 0, dates: [] };
            const datesSet = new Set();
            const isSpot = (asset === "XAU_USD" || asset === "XAG_USD");

            // 1. Gather all dates from daily_tick_archives
            try {
                const archRes = await queryD1(
                    "SELECT DISTINCT date FROM daily_tick_archives WHERE asset = ?",
                    [asset]
                );
                const rows = archRes.result?.[0]?.results || [];
                for (const r of rows) {
                    if (r.date) datesSet.add(r.date);
                }
            } catch (e) {
                logDebug(`[RECALC ARCH ERROR] ${asset}: ${e.message}`);
            }

            // 2. Gather dates from prices table
            try {
                const pricesRes = await queryD1(
                    "SELECT DISTINCT date FROM prices WHERE asset = ?",
                    [asset]
                );
                const pRows = pricesRes.result?.[0]?.results || [];
                for (const r of pRows) {
                    if (r.date) datesSet.add(r.date);
                }
            } catch (e) {
                logDebug(`[RECALC PRICES ERROR] ${asset}: ${e.message}`);
            }

            // 3. Gather dates from intraday_prices table range
            try {
                const legRes = await queryD1(
                    "SELECT MIN(timestamp) as min_ts, MAX(timestamp) as max_ts FROM intraday_prices WHERE asset = ?",
                    [asset]
                );
                const row = legRes.result?.[0]?.results?.[0];
                if (row && row.min_ts && row.max_ts) {
                    for (let ts = Number(row.min_ts); ts <= Number(row.max_ts); ts += 86400 * 1000) {
                        datesSet.add(getAssetDateStringForTimestamp(asset, ts));
                    }
                    datesSet.add(getAssetDateStringForTimestamp(asset, Number(row.max_ts)));
                }
            } catch (e) {}

            // 4. Always include active trading date and today
            if (isSpot) {
                datesSet.add(getSpotAssetDateString());
            } else {
                datesSet.add(getIstDateString());
            }

            const sortedDates = Array.from(datesSet).sort().reverse();
            logDebug(`[RECALC] Checking ${sortedDates.length} candidate dates for ${asset}...`);

            for (const dateStr of sortedDates) {
                try {
                    // Skip Saturday & Sunday for COMEX Spot assets since exchange is closed
                    if (isSpot) {
                        const dayOfWeek = new Date(dateStr + 'T12:00:00Z').getUTCDay();
                        if (dayOfWeek === 0 || dayOfWeek === 6) {
                            continue;
                        }
                    }

                    let ticks = [];

                    // a. Check daily_tick_archives
                    const archRes = await queryD1(
                        "SELECT ticks_json FROM daily_tick_archives WHERE asset = ? AND date = ? LIMIT 1",
                        [asset, dateStr]
                    );
                    const archRow = archRes.result?.[0]?.results?.[0];
                    if (archRow && archRow.ticks_json) {
                        try {
                            const parsed = JSON.parse(archRow.ticks_json);
                            if (Array.isArray(parsed) && parsed.length > 0) {
                                ticks = parsed;
                            }
                        } catch (e) {}
                    }

                    const range = getTimestampRangeForDate(asset, dateStr);

                    // b. Check intraday_minute_ticks (always for Spot assets to capture ticks after midnight up to 02:30 AM close)
                    if (range && (ticks.length === 0 || isSpot)) {
                        const minRes = await queryD1(
                            "SELECT minute_timestamp, ticks_json FROM intraday_minute_ticks WHERE asset = ? AND minute_timestamp >= ? AND minute_timestamp <= ? ORDER BY minute_timestamp ASC",
                            [asset, range.startMs, range.endMs]
                        );
                        const minRows = minRes.result?.[0]?.results || [];
                        const seenTs = new Set(ticks.map(t => t.timestamp));
                        for (const row of minRows) {
                            try {
                                const parsed = JSON.parse(row.ticks_json);
                                if (Array.isArray(parsed)) {
                                    for (const t of parsed) {
                                        if (t && !seenTs.has(t.timestamp)) {
                                            ticks.push(t);
                                            seenTs.add(t.timestamp);
                                        }
                                    }
                                }
                            } catch (e) {}
                        }
                    }

                    // c. Check legacy intraday_prices if still empty
                    if (ticks.length === 0 && range) {
                        const legTicksRes = await queryD1(
                            "SELECT timestamp, price FROM intraday_prices WHERE asset = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC",
                            [asset, range.startMs, range.endMs]
                        );
                        const legTicks = legTicksRes.result?.[0]?.results || [];
                        for (const r of legTicks) {
                            ticks.push({ timestamp: Number(r.timestamp), price: Number(r.price) });
                        }
                    }

                    // d. Merge inMemoryTicks across session range
                    if (range && inMemoryTicks[asset]) {
                        const memTicks = inMemoryTicks[asset] || [];
                        if (memTicks.length > 0) {
                            const inRangeMem = memTicks.filter(t => t.timestamp >= range.startMs && t.timestamp <= range.endMs);
                            if (inRangeMem.length > 0) {
                                const seen = new Set(ticks.map(t => t.timestamp));
                                for (const t of inRangeMem) {
                                    if (t && !seen.has(t.timestamp)) {
                                        ticks.push(t);
                                        seen.add(t.timestamp);
                                    }
                                }
                            }
                        }
                    }

                    // Filter valid positive ticks
                    const validTicks = ticks.filter(t => t && Number(t.price) > 0 && !isNaN(Number(t.price)));
                    if (validTicks.length === 0) {
                        continue;
                    }

                    validTicks.sort((a, b) => a.timestamp - b.timestamp);

                    const open = Number(validTicks[0].price);
                    const close = Number(validTicks[validTicks.length - 1].price);
                    let high = open;
                    let low = open;
                    for (let i = 0; i < validTicks.length; i++) {
                        const p = Number(validTicks[i].price);
                        if (p > high) high = p;
                        if (p < low && p > 0) low = p;
                    }

                    const lastTs = validTicks[validTicks.length - 1].timestamp || Date.now();

                    // Upsert into prices table directly
                    const updRes = await queryD1(
                        "UPDATE prices SET open = ?, high = ?, low = ?, close = ?, timestamp = ? WHERE asset = ? AND date = ?",
                        [open, high, low, close, lastTs, asset, dateStr]
                    );

                    if (updRes?.result?.[0]?.meta?.changes === 0) {
                        await queryD1(
                            "INSERT INTO prices (asset, date, open, high, low, close, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            [asset, dateStr, open, high, low, close, lastTs]
                        );
                    }

                    // Write complete consolidated ticks to daily_tick_archives (especially after merging post-midnight ticks for Spot)
                    if ((isSpot || !archRow) && validTicks.length > 0) {
                        try {
                            const jsonStr = JSON.stringify(validTicks);
                            await queryD1(
                                "INSERT OR REPLACE INTO daily_tick_archives (asset, date, ticks_json) VALUES (?, ?, ?)",
                                [asset, dateStr, jsonStr]
                            );
                        } catch (e) {}
                    }

                    summary[asset].updatedDates++;
                    summary[asset].dates.push({
                        date: dateStr,
                        ticksCount: validTicks.length,
                        open,
                        high,
                        low,
                        close
                    });
                    logDebug(`[RECALC MATCH] ${asset} ${dateStr} (${validTicks.length} ticks) -> O:${open}, H:${high}, L:${low}, C:${close}`);
                } catch (dateErr) {
                    logDebug(`[RECALC DATE ERROR] ${asset} ${dateStr}: ${dateErr.message}`);
                }
            }
            logDebug(`[RECALC] ${asset}: Successfully synchronized ${summary[asset].updatedDates} dates!`);
        }

        historicalCache.clear();
        loggedDatesCache.clear();
        logDebug("[RECALC COMPLETE] All historical daily OHLC rates re-calculated and synchronized from ticks!");
        return summary;
    } catch (e) {
        logDebug(`[RECALC FATAL] Recalculate error: ${e.message}`);
        throw e;
    }
}

async function ensureHistoricalBaselines() {
    try {
        const countRes = await queryD1("SELECT COUNT(*) as cnt FROM prices");
        const count = countRes?.result?.[0]?.results?.[0]?.cnt || 0;
        if (count >= 50) {
            logDebug(`[BASELINES] Prices table already has ${count} historical rows. Skipping repetitive baseline inserts.`);
            return;
        }

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

        // Spot Gold (XAU_USD) - Weekdays only
        await upsertPriceRow('XAU_USD', '2026-08-21', 4521.45, 4632.55, 4509.85, 4603.30);
        await upsertPriceRow('XAU_USD', '2026-08-20', 4522.65, 4540.80, 4451.10, 4519.20);
        await upsertPriceRow('XAU_USD', '2026-08-19', 4333.85, 4525.00, 4325.75, 4522.65);

        // Spot Silver (XAG_USD) - Weekdays only
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

        // Sep 4, 2026 OHLC summaries (calculated from the 31,800 ticks recorded on that day)
        await upsertPriceRow('GOLD_999_GST', '2026-09-04', 160004, 160582, 156255, 157668);
        await upsertPriceRow('GOLD_MCX', '2026-09-04', 155154, 155732, 151405, 152818);
        await upsertPriceRow('SILVER_MCX', '2026-09-04', 241342, 242129, 234847, 237550);
        await upsertPriceRow('XAU_USD', '2026-09-04', 4480.35, 4491.40, 4366.30, 4430.90);
        await upsertPriceRow('XAG_USD', '2026-09-04', 66.98, 67.22, 64.79, 66.22);

        // Sep 2, 2026 MCX / GST OHLC
        await upsertPriceRow('GOLD_999_GST', '2026-09-02', 157419, 159100, 157150, 158916);
        await upsertPriceRow('GOLD_MCX', '2026-09-02', 152119, 153900, 151850, 153707);
        await upsertPriceRow('SILVER_MCX', '2026-09-02', 235745, 238600, 235200, 238273);

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

// Preload latest OHLC from Cloudflare D1 so server restarts never lose or overwrite morning Open
async function preloadLatestOhlcFromD1() {
    try {
        logDebug("[STARTUP] Preloading latest OHLC from Cloudflare D1 into inMemoryOhlc...");
        const assets = ["GOLD_MCX", "SILVER_MCX", "GOLD_999_GST", "XAU_USD", "XAG_USD"];
        for (const asset of assets) {
            const res = await queryD1(
                "SELECT asset, date, open, high, low, close, timestamp FROM prices WHERE asset = ? ORDER BY date DESC, id DESC LIMIT 1",
                [asset]
            );
            const row = res.result?.[0]?.results?.[0];
            if (row && row.open > 0) {
                inMemoryOhlc[asset] = {
                    asset: row.asset,
                    date: row.date,
                    open: row.open,
                    high: row.high,
                    low: row.low,
                    close: row.close,
                    timestamp: row.timestamp || Date.now()
                };
                logDebug(`[PRELOAD OHLC] Loaded ${asset} (${row.date}): O=${row.open}, H=${row.high}, L=${row.low}, C=${row.close}`);
            }
        }
    } catch (e) {
        logDebug(`[PRELOAD OHLC ERROR] ${e.message}`);
    }
}

// Preload today's intraday minute ticks from D1 into inMemoryTicks on startup
async function preloadTodayTicksFromD1() {
    try {
        logDebug("[STARTUP] Preloading today's minute ticks from Cloudflare D1 into inMemoryTicks...");
        const assets = ["GOLD_MCX", "SILVER_MCX", "GOLD_999_GST", "XAU_USD", "XAG_USD"];
        const todayStr = getIstDateString();
        for (const asset of assets) {
            const range = getTimestampRangeForDate(asset, todayStr);
            if (!range) continue;
            const bucketRes = await queryD1(
                "SELECT minute_timestamp, ticks_json FROM intraday_minute_ticks WHERE asset = ? AND minute_timestamp >= ? AND minute_timestamp <= ? ORDER BY minute_timestamp DESC",
                [asset, range.startMs, range.endMs]
            );
            const bucketRows = bucketRes.result?.[0]?.results || [];
            const loadedTicks = [];
            for (const row of bucketRows) {
                try {
                    const parsed = JSON.parse(row.ticks_json);
                    if (Array.isArray(parsed)) {
                        loadedTicks.push(...parsed);
                    }
                } catch (e) {}
            }
            if (loadedTicks.length < 50) {
                const dbRes = await queryD1(
                    "SELECT timestamp, price FROM intraday_prices WHERE asset = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC",
                    [asset, range.startMs, range.endMs]
                );
                const legRows = dbRes.result?.[0]?.results || [];
                for (const r of legRows) {
                    loadedTicks.push({ timestamp: Number(r.timestamp), price: Number(r.price) });
                }
            }
            if (loadedTicks.length > 0) {
                const existing = inMemoryTicks[asset] || [];
                const existingTs = new Set(existing.map(t => t.timestamp));
                for (const t of loadedTicks) {
                    if (!existingTs.has(t.timestamp)) {
                        existing.push(t);
                    }
                }
                existing.sort((a, b) => b.timestamp - a.timestamp);
                inMemoryTicks[asset] = existing.slice(0, 10000);
                logDebug(`[PRELOAD TICKS] Preloaded ${loadedTicks.length} ticks from D1 for ${asset}`);
            }
        }
    } catch (e) {
        logDebug(`[PRELOAD TICKS ERROR] ${e.message}`);
    }
}

// Create database indexes on launch to optimize queries
async function initDatabaseIndexes() {
    try {
        logDebug("Initializing D1 Database indexes and tables...");
        await queryD1("CREATE TABLE IF NOT EXISTS daily_tick_archives (id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT, date TEXT, ticks_json TEXT)");
        await queryD1("CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_tick_archives_asset_date ON daily_tick_archives(asset, date)");
        await queryD1("CREATE TABLE IF NOT EXISTS intraday_minute_ticks (id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT, minute_timestamp INTEGER, ticks_json TEXT)");
        await queryD1("CREATE INDEX IF NOT EXISTS idx_minute_ticks_asset_ts ON intraday_minute_ticks(asset, minute_timestamp)");
        await queryD1("CREATE INDEX IF NOT EXISTS idx_intraday_prices_asset_timestamp ON intraday_prices(asset, timestamp)");
        await queryD1("CREATE INDEX IF NOT EXISTS idx_prices_asset_date ON prices(asset, date)");
        await ensureHistoricalBaselines();
        await recalculateAllOHLCFromTicks();
        await preloadLatestOhlcFromD1();
        await preloadTodayTicksFromD1();
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
