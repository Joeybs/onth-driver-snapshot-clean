# Amazon Driver Snapshot - Optimized

Production-ready userscript for Amazon logistics platform with comprehensive performance optimizations, reliability improvements, and security enhancements.

## Features

- **In-page Driver Snapshot Drawer**: View all driver data in an organized, sortable table
- **Smart Address Copying**: Automatically copies Nth remaining stop address (default: 5th)
- **Auto-Navigation**: Opens driver itinerary, hides completed stops, and returns to list
- **Performance Optimized**: Debounced inputs, batch DOM updates, smooth scrolling
- **Reliable**: Comprehensive error handling, retry mechanisms, timeout protection
- **Secure**: Input sanitization, XSS prevention, validated JSON processing

## Installation

1. Install a userscript manager (Tampermonkey, Greasemonkey, etc.)
2. Click [Install Script](https://raw.githubusercontent.com/Joeybs/onth-driver-snapshot-clean/main/amazon-driver-snapshot.user.js)
3. Navigate to `https://logistics.amazon.com/operations/execution/itineraries`

## Performance Optimizations (v2.1.0)

### ✅ Debounced Operations
- Filter input: 300ms debounce to reduce unnecessary re-renders
- Refresh button: Debounced to prevent rapid clicks
- Stop number input: Validated and debounced

### ✅ Smooth Scrolling
- RequestAnimationFrame-based scrolling for 60fps performance
- Eased animations for better UX
- Fallback to instant scroll on errors

### ✅ Batch DOM Updates
- DocumentFragment for table rendering
- Single reflow per render cycle
- Minimized style recalculations

### ✅ Smart Caching
- LRU cache for address data (500 item limit)
- WeakMap for element tracking
- Cached itinerary JSON responses

### ✅ Performance Monitoring
- Built-in performance timer (`perf` utility)
- Debug mode: Set `window.__ONTH_DEBUG__ = true`
- Tracks timing for critical operations

## Reliability Improvements

### ✅ Error Handling
- Try-catch blocks around all critical operations
- Graceful degradation on failures
- Detailed error logging with context

### ✅ Input Validation
- Stop number: Min 1, Max 999
- Filter text: Sanitized for XSS prevention
- JSON responses: Validated before processing

### ✅ Network Resilience
- 15-second timeout on fetch operations
- 3 automatic retry attempts
- Proper AbortController usage

### ✅ Memory Management
- Cleanup system for event listeners
- Interval and observer tracking
- Automatic cleanup on page unload

## Security Enhancements

### ✅ XSS Prevention
- Input sanitization on all user text
- HTML entity encoding
- Safe DOM manipulation

### ✅ Validated Operations
- JSON response validation
- Type checking on external data
- Safe clipboard operations with fallbacks

### ✅ CSP Compliance
- No inline scripts or eval
- Proper event handler attachment
- Clean separation of concerns

## Debug Mode

Enable detailed logging:
```javascript
window.__ONTH_DEBUG__ = true
```

This provides:
- Performance timing for all operations
- Detailed function call traces
- Network request/response logging

## Code Quality

- **652 insertions, 196 deletions** in optimization refactor
- **0 CodeQL security alerts**
- **JSDoc comments** on complex functions
- **Null-safe operations** throughout
- **Professional-grade** error handling

## Version History

### v2.1.0 (Latest)
- Complete performance optimization
- Comprehensive error handling
- Security hardening
- Memory leak prevention
- Debug mode added

### v2.0.0
- Initial improved version
- Basic reliability improvements

## Contributing

This is a production-ready, fully optimized codebase. All major performance, reliability, and security improvements have been implemented.