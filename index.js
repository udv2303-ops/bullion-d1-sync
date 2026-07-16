const http = require('http');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const https = require('https');
const urlModule = require('url');
const { exec } = require('child_process');

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
        const payload = JSON.stringify({ sql, params });
        const options = {
            hostname: 'api.cloudflare.com',
            path: `/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json',
                'Content-Length': payload.length
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
        req.write(payload);
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

async function saveIntradayTick(asset, price) {
    const currentPrice = toDoubleSafe(price);
    if (currentPrice <= 0.0) return;

    // We record ticks unconditionally every 10 seconds as requested (even if the rate is identical)

    lastPrices[asset] = currentPrice;
    const timestamp = Date.now();

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

async function saveDailySummary(asset, dateStr, open, high, low, close) {
    try {
        const timestamp = Date.now();
        const checkRes = await queryD1(
            "SELECT id, open, high, low FROM prices WHERE asset = ? AND date = ?",
            [asset, dateStr]
        );
        const rows = checkRes.result?.[0]?.results || [];

        if (rows.length > 0) {
            const existing = rows[0];
            const updatedOpen = existing.open || open;
            const updatedHigh = Math.max(existing.high || 0.0, high);
            const updatedLow = existing.low <= 0.0 ? low : Math.min(existing.low, low);

            await queryD1(
                "UPDATE prices SET open = ?, high = ?, low = ?, close = ?, timestamp = ? WHERE id = ?",
                [updatedOpen, updatedHigh, updatedLow, close, timestamp, existing.id]
            );
        } else {
            await queryD1(
                "INSERT INTO prices (asset, date, open, high, low, close, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [asset, dateStr, open, high, low, close, timestamp]
            );
        }
    } catch (e) {
        logDebug(`[SUMMARY ERROR] Failed to save daily summary for ${asset}: ${e.message}`);
    }
}

// 1. Sync Spot Assets (Gold, Silver, USD_INR) via Yahoo Finance API (COMEX GC=F, SI=F, INR=X)
async function syncSpotAsset(assetName, yahooTicker, syncHistory = false) {
    try {
        const range = syncHistory ? "30d" : "5d";
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=${range}`;
        const raw = await fetchUrl(url);
        const yahooData = JSON.parse(raw);
        const result = yahooData.chart?.result?.[0];
        
        if (result && result.timestamp && result.indicators && result.indicators.quote && result.indicators.quote[0]) {
            const quote = result.indicators.quote[0];
            const timestamps = result.timestamp;
            
            if (syncHistory) {
                // Loop through all historical data points to fill in D1 database
                for (let i = 0; i < timestamps.length; i++) {
                    const openVal = toDoubleSafe(quote.open[i]);
                    const closeVal = toDoubleSafe(quote.close[i]);
                    const highVal = toDoubleSafe(quote.high[i]) || closeVal;
                    const lowVal = toDoubleSafe(quote.low[i]) || closeVal;
                    
                    if (closeVal > 0.0) {
                        const date = new Date(timestamps[i] * 1000);
                        const istTime = new Date(date.getTime() + (5.5 * 60 * 60 * 1000));
                        const dateStr = istTime.toISOString().split('T')[0];
                        await saveDailySummary(assetName, dateStr, openVal, highVal, lowVal, closeVal);
                    }
                }
                logDebug(`[HISTORY] Synced ${timestamps.length} historical entries for ${assetName}`);
            } else {
                // Only sync the latest element for the 10-second tick
                const idx = timestamps.length - 1;
                if (idx >= 0) {
                    const openVal = toDoubleSafe(quote.open[idx]);
                    const closeVal = toDoubleSafe(quote.close[idx]);
                    const highVal = toDoubleSafe(quote.high[idx]) || closeVal;
                    const lowVal = toDoubleSafe(quote.low[idx]) || closeVal;
                    
                    if (closeVal > 0.0) {
                        const dateStr = getIstDateString();
                        await saveDailySummary(assetName, dateStr, openVal, highVal, lowVal, closeVal);
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
        const daysBack = syncHistory ? 30 : 5;
        const fromTimestamp = toTimestamp - daysBack * 24 * 3600;

        const sym = `${symbolPrefix}_${expiryDate}_MCX`;
        const historyUrl = `https://priceapi.moneycontrol.com/techCharts/commodity/history?symbol=${sym}&resolution=D&from=${fromTimestamp}&to=${toTimestamp}`;
        const raw = await fetchUrl(historyUrl);
        const tvcData = JSON.parse(raw);

        if (tvcData.s === "ok" && tvcData.t && tvcData.o) {
            if (syncHistory) {
                // Loop through all historical data points to fill in D1 database
                for (let i = 0; i < tvcData.t.length; i++) {
                    const openVal = toDoubleSafe(tvcData.o[i]);
                    const closeVal = toDoubleSafe(tvcData.c[i]);
                    const highVal = toDoubleSafe(tvcData.h[i]) || closeVal;
                    const lowVal = toDoubleSafe(tvcData.l[i]) || closeVal;

                    if (closeVal > 0.0) {
                        const date = new Date(tvcData.t[i] * 1000);
                        const istTime = new Date(date.getTime() + (5.5 * 60 * 60 * 1000));
                        const dateStr = istTime.toISOString().split('T')[0];
                        await saveDailySummary(assetName, dateStr, openVal, highVal, lowVal, closeVal);
                    }
                }
                logDebug(`[HISTORY] Synced ${tvcData.t.length} historical entries for ${assetName}`);
            } else {
                const dateStr = getIstDateString();
                const idx = tvcData.t.length - 1;
                if (idx >= 0) {
                    const openVal = toDoubleSafe(tvcData.o[idx]);
                    const closeVal = toDoubleSafe(tvcData.c[idx]);
                    const highVal = toDoubleSafe(tvcData.h[idx]) || closeVal;
                    const lowVal = toDoubleSafe(tvcData.l[idx]) || closeVal;

                    if (closeVal > 0.0) {
                        await saveDailySummary(assetName, dateStr, openVal, highVal, lowVal, closeVal);
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
            
            if (closeVal <= 0.0) continue;
            
            if (name === "GOLD") {
                // Spot Gold
                await saveDailySummary("XAU_USD", dateStr, bidVal, highVal, lowVal, closeVal);
                await saveIntradayTick("XAU_USD", closeVal);
                logDebug(`[HARIKALA-SPOT] Synced XAU_USD: ${closeVal}`);
            }
            else if (name === "SILVER") {
                // Spot Silver
                await saveDailySummary("XAG_USD", dateStr, bidVal, highVal, lowVal, closeVal);
                await saveIntradayTick("XAG_USD", closeVal);
                logDebug(`[HARIKALA-SPOT] Synced XAG_USD: ${closeVal}`);
            }
            else if (name === "GOLD 999 IMP WITH GST (Today)") {
                // GST Gold (Only during active trading hours: 09:00 AM - 11:50 PM IST)
                const d = new Date();
                const istTime = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
                const hour = istTime.getUTCHours();
                const minute = istTime.getUTCMinutes();
                const minutesSinceMidnight = hour * 60 + minute;
                
                const startMinutes = 9 * 60;
                const endMinutes = 23 * 60 + 50;
                
                if (minutesSinceMidnight >= startMinutes && minutesSinceMidnight <= endMinutes) {
                    await saveDailySummary("GOLD_999_GST", dateStr, bidVal, highVal, lowVal, closeVal);
                    await saveIntradayTick("GOLD_999_GST", closeVal);
                    logDebug(`[HARIKALA-SPOT] Synced GOLD_999_GST: ${closeVal}`);
                }
            }
        }
    } catch (e) {
        logDebug(`Error syncing Harikala Broadcast: ${e.message}`);
    }
}

let lastHistoricalSyncTime = 0;

// Main sync scheduling loop
async function runSyncCycle() {
    logDebug(`[SYNC CYCLE START]`);
    
    const now = Date.now();
    const shouldSyncHistory = (now - lastHistoricalSyncTime > 12 * 60 * 60 * 1000); // every 12 hours
    
    if (shouldSyncHistory) {
        logDebug("[HISTORICAL SYNC START]");
        lastHistoricalSyncTime = now;
        
        // Run historical backfills in parallel to save startup time
        try {
            await Promise.all([
                syncSpotAsset("XAU_USD", "GC=F", true),
                syncSpotAsset("XAG_USD", "SI=F", true),
                syncMcxAsset("GOLD_MCX", "https://www.moneycontrol.com/commodity/gold-price.html", "GOLD", true),
                syncMcxAsset("SILVER_MCX", "https://www.moneycontrol.com/commodity/silver-price.html", "SILVER", true)
            ]);
        } catch (err) {
            logDebug(`Error in parallel historical sync: ${err.message}`);
        }
        logDebug("[HISTORICAL SYNC END]");
    }

    // Run all live sync queries in parallel (reduces wait time from 5s+ to ~1s)
    try {
        await Promise.all([
            syncHarikalaBroadcast(),
            syncMcxAsset("GOLD_MCX", "https://www.moneycontrol.com/commodity/gold-price.html", "GOLD", false),
            syncMcxAsset("SILVER_MCX", "https://www.moneycontrol.com/commodity/silver-price.html", "SILVER", false)
        ]);
    } catch (err) {
        logDebug(`Error in parallel live sync: ${err.message}`);
    }

    logDebug(`[SYNC CYCLE END]`);
}

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
    const path = parsedUrl.pathname;
    const query = parsedUrl.query;

    try {
        if (path === '/api/live') {
            const dbRes = await queryD1(
                "SELECT p1.* FROM prices p1 JOIN (SELECT asset, MAX(date) as max_date FROM prices GROUP BY asset) p2 ON p1.asset = p2.asset AND p1.date = p2.max_date"
            );
            const results = dbRes.result?.[0]?.results || [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
        }
        else if (path === '/api/historical') {
            const asset = query.asset;
            const dbRes = await queryD1(
                "SELECT date, open, high, low, close, timestamp FROM prices WHERE asset = ? ORDER BY date DESC",
                [asset]
            );
            const results = dbRes.result?.[0]?.results || [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
        }
        else if (path === '/api/logged-dates') {
            const asset = query.asset;
            const dbRes = await queryD1(
                "SELECT DISTINCT date((timestamp + 19800000)/1000, 'unixepoch') as date FROM intraday_prices WHERE asset = ? ORDER BY date DESC",
                [asset]
            );
            const results = dbRes.result?.[0]?.results || [];
            const datesList = results.map(r => r.date);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(datesList));
        }
        else if (path === '/api/ticks') {
            const asset = query.asset;
            const date = query.date; // YYYY-MM-DD
            const dbRes = await queryD1(
                "SELECT timestamp, price FROM intraday_prices WHERE asset = ? AND date((timestamp + 19800000)/1000, 'unixepoch') = ? ORDER BY timestamp DESC",
                [asset, date]
            );
            const results = dbRes.result?.[0]?.results || [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
        }
        else if (path === '/api/clean-old-data') {
            logDebug("[MAINTENANCE] Cleaning old spot gold/silver history...");
            const delPrices = await queryD1(
                "DELETE FROM prices WHERE asset IN ('XAU_USD', 'XAG_USD') AND date < '2026-07-16'"
            );
            const delTicks = await queryD1(
                "DELETE FROM intraday_prices WHERE asset IN ('XAU_USD', 'XAG_USD') AND timestamp < 1784208300000"
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true, 
                message: "Old spot gold/silver history deleted successfully.", 
                delPricesResult: delPrices, 
                delTicksResult: delTicks 
            }));
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
async function initDatabaseIndexes() {
    try {
        logDebug("Initializing D1 Database indexes...");
        await queryD1("CREATE INDEX IF NOT EXISTS idx_intraday_prices_asset_timestamp ON intraday_prices(asset, timestamp)");
        await queryD1("CREATE INDEX IF NOT EXISTS idx_prices_asset_date ON prices(asset, date)");
        logDebug("D1 Database indexes initialized successfully.");
    } catch (e) {
        logDebug(`[INDEX INIT ERROR] Failed to create database indexes: ${e.message}`);
    }
}

// Run immediately on launch
(async () => {
    await initDatabaseIndexes();
    runSyncCycle();
})();

// Run every 10 seconds
setInterval(runSyncCycle, 10000);
