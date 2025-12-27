// ==UserScript==
// @name         Amazon Driver Snapshot
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Optimized snapshot collection for Amazon driver application
// @author       Joeybs
// @match        https://flex.amazon.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ===========================
    // OPTIMIZED CONFIGURATION
    // ===========================
    const CONFIG = {
        MAX_RETRIES: 1,              // Reduced from 3 to 1
        BASE_SLEEP_MS: 500,          // Reduced from 1000 (50% cut)
        ADDRESS_FETCH_SLEEP_MS: 250, // Reduced from 500 (50% cut)
        MAX_SCROLL_LOOPS: 100,       // Reduced from 160
        SCROLL_DELAY_MS: 250,        // Reduced from 500 (50% cut)
        DATA_COLLECTION_TIMEOUT: 30000,
        SNAPSHOT_VERSION: '2.0'
    };

    // ===========================
    // UTILITY FUNCTIONS
    // ===========================
    
    /**
     * Sleep for specified milliseconds
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Retry logic with exponential backoff
     */
    async function retryWithBackoff(fn, maxRetries = CONFIG.MAX_RETRIES) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                if (attempt === maxRetries) {
                    console.error(`Failed after ${maxRetries + 1} attempts:`, error);
                    throw error;
                }
                const delayMs = CONFIG.BASE_SLEEP_MS * Math.pow(2, attempt);
                console.log(`Attempt ${attempt + 1} failed, retrying in ${delayMs}ms...`);
                await sleep(delayMs);
            }
        }
    }

    /**
     * Safe JSON stringify with circular reference handling
     */
    function safeStringify(obj, space = 2) {
        const seen = new WeakSet();
        return JSON.stringify(obj, (key, value) => {
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return '[Circular]';
                }
                seen.add(value);
            }
            return value;
        }, space);
    }

    // ===========================
    // DATA COLLECTION
    // ===========================

    /**
     * Extract page title
     */
    function getPageTitle() {
        return document.title || 'Unknown';
    }

    /**
     * Extract URL with query parameters
     */
    function getPageURL() {
        return window.location.href;
    }

    /**
     * Extract viewport information
     */
    function getViewportInfo() {
        return {
            width: window.innerWidth,
            height: window.innerHeight,
            scrollX: window.scrollX,
            scrollY: window.scrollY
        };
    }

    /**
     * Extract all text content from the page
     */
    function getPageContent() {
        const bodyText = document.body.innerText || '';
        const bodyHTML = document.body.innerHTML;
        return {
            textLength: bodyText.length,
            htmlLength: bodyHTML.length,
            preview: bodyText.substring(0, 5000)
        };
    }

    /**
     * Extract form data from the current page
     */
    function getFormData() {
        const forms = document.querySelectorAll('form');
        const formData = [];
        
        forms.forEach((form, index) => {
            const fields = [];
            const inputs = form.querySelectorAll('input, select, textarea');
            
            inputs.forEach(input => {
                if (input.type !== 'password') {
                    fields.push({
                        name: input.name || input.id,
                        type: input.type,
                        value: input.value
                    });
                }
            });
            
            formData.push({
                formIndex: index,
                action: form.action,
                method: form.method,
                fieldCount: fields.length,
                fields: fields.slice(0, 20) // Limit to first 20 fields
            });
        });
        
        return formData;
    }

    /**
     * Extract API response data from network
     */
    function getNetworkData() {
        const networkData = window.performance?.getEntriesByType?.('resource') || [];
        return {
            totalRequests: networkData.length,
            resourceTypes: [...new Set(networkData.map(r => r.initiatorType))],
            apiEndpoints: networkData
                .filter(r => r.name.includes('/api/'))
                .map(r => ({
                    url: r.name,
                    duration: r.duration
                }))
                .slice(0, 10)
        };
    }

    /**
     * Extract address information (with redundant retry elimination)
     */
    async function extractAddressData() {
        const addressElements = document.querySelectorAll('[data-testid*="address"], .address, .location');
        const addresses = [];
        
        for (const element of addressElements) {
            const text = element.innerText?.trim() || '';
            if (text && text.length > 0) {
                addresses.push({
                    text: text.substring(0, 500),
                    classes: element.className,
                    testId: element.getAttribute('data-testid')
                });
            }
        }
        
        // ELIMINATED: Redundant retry logic for address fetches
        // Now performs single extraction without retries
        
        return {
            addressCount: addresses.length,
            addresses: addresses.slice(0, 10)
        };
    }

    /**
     * Scroll and collect dynamic content
     */
    async function scrollAndCollectContent() {
        const scrollData = [];
        let previousHeight = 0;
        let loopCount = 0;
        const maxLoops = CONFIG.MAX_SCROLL_LOOPS;

        while (loopCount < maxLoops) {
            loopCount++;
            window.scrollBy(0, window.innerHeight);
            await sleep(CONFIG.SCROLL_DELAY_MS);

            const currentHeight = document.body.scrollHeight;
            
            scrollData.push({
                iteration: loopCount,
                bodyHeight: currentHeight,
                contentLoaded: document.body.innerText.length
            });

            if (currentHeight === previousHeight) {
                console.log('Reached end of page after', loopCount, 'scrolls');
                break;
            }
            previousHeight = currentHeight;
        }

        window.scrollTo(0, 0);
        return scrollData;
    }

    /**
     * Collect all available snapshot data
     */
    async function collectSnapshot() {
        console.log('Starting optimized snapshot collection...');
        const snapshot = {
            timestamp: new Date().toISOString(),
            version: CONFIG.SNAPSHOT_VERSION,
            userAgent: navigator.userAgent,
            pageTitle: getPageTitle(),
            pageURL: getPageURL(),
            viewport: getViewportInfo(),
            content: getPageContent(),
            forms: getFormData(),
            network: getNetworkData(),
            address: await extractAddressData(),
            scrollData: await scrollAndCollectContent(),
            collectionTime: new Date().toISOString()
        };

        console.log('Snapshot collection completed');
        return snapshot;
    }

    // ===========================
    // STORAGE & EXPORT
    // ===========================

    /**
     * Save snapshot to local storage
     */
    function saveSnapshotLocally(snapshot) {
        try {
            const snapshotStr = safeStringify(snapshot);
            localStorage.setItem('lastSnapshot', snapshotStr);
            localStorage.setItem('lastSnapshotTime', snapshot.timestamp);
            console.log('Snapshot saved to local storage');
        } catch (error) {
            console.error('Error saving to local storage:', error);
        }
    }

    /**
     * Export snapshot as JSON file
     */
    function exportSnapshotAsJSON(snapshot) {
        const dataStr = safeStringify(snapshot);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `snapshot-${Date.now()}.json`;
        link.click();
        URL.revokeObjectURL(url);
    }

    // ===========================
    // UI & USER INTERACTION
    // ===========================

    /**
     * Create floating control panel
     */
    function createControlPanel() {
        const panel = document.createElement('div');
        panel.id = 'snapshot-control-panel';
        panel.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            background: #2c3e50;
            border: 2px solid #3498db;
            border-radius: 8px;
            padding: 15px;
            color: white;
            font-family: Arial, sans-serif;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            min-width: 250px;
        `;

        panel.innerHTML = `
            <div style="margin-bottom: 10px; font-weight: bold;">📸 Snapshot Tool</div>
            <button id="collect-snapshot-btn" style="
                width: 100%;
                padding: 10px;
                margin-bottom: 8px;
                background: #3498db;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-weight: bold;
            ">Collect Snapshot</button>
            <button id="export-snapshot-btn" style="
                width: 100%;
                padding: 10px;
                background: #27ae60;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-weight: bold;
            ">Export JSON</button>
            <div id="status-text" style="
                margin-top: 10px;
                padding: 10px;
                background: #34495e;
                border-radius: 4px;
                font-size: 12px;
                max-height: 100px;
                overflow-y: auto;
            ">Ready</div>
        `;

        document.body.appendChild(panel);

        // Event listeners
        document.getElementById('collect-snapshot-btn').addEventListener('click', async () => {
            const statusText = document.getElementById('status-text');
            statusText.textContent = 'Collecting snapshot...';
            try {
                window.lastSnapshot = await collectSnapshot();
                saveSnapshotLocally(window.lastSnapshot);
                statusText.textContent = '✅ Snapshot collected successfully!';
            } catch (error) {
                statusText.textContent = '❌ Error: ' + error.message;
            }
        });

        document.getElementById('export-snapshot-btn').addEventListener('click', () => {
            if (window.lastSnapshot) {
                exportSnapshotAsJSON(window.lastSnapshot);
                document.getElementById('status-text').textContent = '📥 Exporting snapshot...';
            } else {
                document.getElementById('status-text').textContent = '⚠️ No snapshot collected yet';
            }
        });
    }

    // ===========================
    // INITIALIZATION
    // ===========================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createControlPanel);
    } else {
        createControlPanel();
    }

    console.log('Amazon Driver Snapshot v2.0 - Optimized Edition Loaded');
    console.log('Configuration:', CONFIG);

})();