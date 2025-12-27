// ==UserScript==
// @name         Amazon Driver Snapshot
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Extract driver information from Amazon logistics page
// @author       Joeybs
// @match        https://flex.amazon.com/flex/*
// @icon         https://www.amazon.com/favicon.ico
// @grant        none
// @run-at       document-start
// ==/UserScript==

(async function() {
    'use strict';

    // Extract itineraryId from URL path instead of query parameters
    function getItinParamsFromUrl() {
        const currentUrl = window.location.pathname;
        // Extract itineraryId from path like /flex/deliveries/itinerary/{itineraryId}
        const pathMatch = currentUrl.match(/\/itinerary\/([^\/]+)/);
        if (pathMatch && pathMatch[1]) {
            return {
                itineraryId: pathMatch[1]
            };
        }
        return null;
    }

    async function getItineraryJSON() {
        const params = getItinParamsFromUrl();
        if (!params || !params.itineraryId) {
            console.error('Could not extract itineraryId from URL');
            return null;
        }

        try {
            const response = await fetch(`/flex/api/itinerary/${params.itineraryId}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            return data;
        } catch (error) {
            console.error('Error fetching itinerary:', error);
            return null;
        }
    }

    async function getJsonAddressForStopCurrent() {
        const itineraryData = await getItineraryJSON();
        if (!itineraryData) {
            console.error('Could not retrieve itinerary data');
            return null;
        }

        try {
            // Extract address information from the current stop
            if (itineraryData.stops && itineraryData.stops.length > 0) {
                const currentStop = itineraryData.stops[0];
                return {
                    address: currentStop.address || null,
                    location: currentStop.location || null,
                    stopId: currentStop.stopId || null
                };
            }
            return null;
        } catch (error) {
            console.error('Error extracting address:', error);
            return null;
        }
    }

    // Initialize and capture snapshot
    async function captureSnapshot() {
        try {
            const addressData = await getJsonAddressForStopCurrent();
            if (addressData) {
                console.log('Current Stop Address:', addressData);
                // Perform additional operations with addressData as needed
            }
        } catch (error) {
            console.error('Error capturing snapshot:', error);
        }
    }

    // Wait for page to fully load before capturing
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', captureSnapshot);
    } else {
        captureSnapshot();
    }
})();
