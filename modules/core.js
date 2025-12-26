/**
 * Core Module
 * Contains core utilities, constants, configuration, network hooks, and helper functions
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const CONSTANTS = {
  // API Configuration
  API: {
    BASE_URL: process.env.API_BASE_URL || 'https://api.example.com',
    TIMEOUT: parseInt(process.env.API_TIMEOUT || '30000', 10),
    RETRY_ATTEMPTS: parseInt(process.env.API_RETRY_ATTEMPTS || '3', 10),
    RETRY_DELAY: parseInt(process.env.API_RETRY_DELAY || '1000', 10),
  },
  
  // HTTP Methods
  HTTP_METHODS: {
    GET: 'GET',
    POST: 'POST',
    PUT: 'PUT',
    PATCH: 'PATCH',
    DELETE: 'DELETE',
  },
  
  // HTTP Status Codes
  HTTP_STATUS: {
    OK: 200,
    CREATED: 201,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    INTERNAL_SERVER_ERROR: 500,
    SERVICE_UNAVAILABLE: 503,
  },
  
  // Error Types
  ERROR_TYPES: {
    NETWORK_ERROR: 'NETWORK_ERROR',
    TIMEOUT_ERROR: 'TIMEOUT_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
    SERVER_ERROR: 'SERVER_ERROR',
    NOT_FOUND_ERROR: 'NOT_FOUND_ERROR',
    CONFLICT_ERROR: 'CONFLICT_ERROR',
  },
  
  // Cache Configuration
  CACHE: {
    DEFAULT_TTL: parseInt(process.env.CACHE_TTL || '3600000', 10), // 1 hour
    MAX_ENTRIES: parseInt(process.env.CACHE_MAX_ENTRIES || '1000', 10),
  },
  
  // Logging Levels
  LOG_LEVELS: {
    DEBUG: 'DEBUG',
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR',
  },
};

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Environment
  environment: process.env.NODE_ENV || 'development',
  isDevelopment: (process.env.NODE_ENV || 'development') === 'development',
  isProduction: process.env.NODE_ENV === 'production',
  
  // API Settings
  api: {
    baseUrl: process.env.API_BASE_URL || 'https://api.example.com',
    timeout: CONSTANTS.API.TIMEOUT,
    retryAttempts: CONSTANTS.API.RETRY_ATTEMPTS,
    retryDelay: CONSTANTS.API.RETRY_DELAY,
  },
  
  // Logging Settings
  logging: {
    level: process.env.LOG_LEVEL || CONSTANTS.LOG_LEVELS.INFO,
    format: process.env.LOG_FORMAT || 'json',
    enableConsole: process.env.ENABLE_CONSOLE_LOGS !== 'false',
  },
  
  // Cache Settings
  cache: {
    enabled: process.env.CACHE_ENABLED !== 'false',
    ttl: CONSTANTS.CACHE.DEFAULT_TTL,
    maxEntries: CONSTANTS.CACHE.MAX_ENTRIES,
  },
  
  // Feature Flags
  features: {
    enableCache: process.env.ENABLE_CACHE !== 'false',
    enableRetry: process.env.ENABLE_RETRY !== 'false',
    enableMetrics: process.env.ENABLE_METRICS !== 'false',
  },
};

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Deep clone an object
 * @param {*} obj - Object to clone
 * @returns {*} Cloned object
 */
function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return new Date(obj.getTime());
  if (obj instanceof Array) return obj.map(item => deepClone(item));
  if (obj instanceof Object) {
    const cloned = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        cloned[key] = deepClone(obj[key]);
      }
    }
    return cloned;
  }
  return obj;
}

/**
 * Merge objects recursively
 * @param {Object} target - Target object
 * @param {...Object} sources - Source objects
 * @returns {Object} Merged object
 */
function deepMerge(target, ...sources) {
  if (!sources.length) return target;
  const source = sources.shift();
  
  if (typeof target === 'object' && typeof source === 'object') {
    for (const key in source) {
      if (typeof source[key] === 'object') {
        if (!target[key]) Object.assign(target, { [key]: {} });
        deepMerge(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }
  
  return deepMerge(target, ...sources);
}

/**
 * Check if value is empty
 * @param {*} value - Value to check
 * @returns {boolean} True if empty
 */
function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Safely parse JSON
 * @param {string} jsonString - JSON string
 * @param {*} defaultValue - Default value if parsing fails
 * @returns {*} Parsed object or default value
 */
function safeJsonParse(jsonString, defaultValue = null) {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    return defaultValue;
  }
}

/**
 * Safely stringify object
 * @param {*} obj - Object to stringify
 * @param {*} defaultValue - Default value if stringification fails
 * @returns {string} JSON string or default value
 */
function safeJsonStringify(obj, defaultValue = '{}') {
  try {
    return JSON.stringify(obj);
  } catch (error) {
    return defaultValue;
  }
}

/**
 * Generate a unique ID
 * @returns {string} Unique ID
 */
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Debounce function
 * @param {Function} func - Function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {Function} Debounced function
 */
function debounce(func, delay) {
  let timeoutId;
  return function debounced(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func.apply(this, args), delay);
  };
}

/**
 * Throttle function
 * @param {Function} func - Function to throttle
 * @param {number} interval - Interval in milliseconds
 * @returns {Function} Throttled function
 */
function throttle(func, interval) {
  let lastCall = 0;
  return function throttled(...args) {
    const now = Date.now();
    if (now - lastCall >= interval) {
      lastCall = now;
      func.apply(this, args);
    }
  };
}

// ============================================================================
// NETWORK HOOKS
// ============================================================================

const networkHooks = {
  // Request interceptors
  requestInterceptors: [],
  
  // Response interceptors
  responseInterceptors: [],
  
  // Error interceptors
  errorInterceptors: [],
  
  /**
   * Register a request interceptor
   * @param {Function} interceptor - Interceptor function
   */
  onRequest(interceptor) {
    this.requestInterceptors.push(interceptor);
  },
  
  /**
   * Register a response interceptor
   * @param {Function} interceptor - Interceptor function
   */
  onResponse(interceptor) {
    this.responseInterceptors.push(interceptor);
  },
  
  /**
   * Register an error interceptor
   * @param {Function} interceptor - Interceptor function
   */
  onError(interceptor) {
    this.errorInterceptors.push(interceptor);
  },
  
  /**
   * Execute request interceptors
   * @param {Object} requestConfig - Request configuration
   * @returns {Object} Modified request configuration
   */
  async executeRequestInterceptors(requestConfig) {
    let config = deepClone(requestConfig);
    for (const interceptor of this.requestInterceptors) {
      config = await interceptor(config);
    }
    return config;
  },
  
  /**
   * Execute response interceptors
   * @param {Object} response - Response object
   * @returns {Object} Modified response
   */
  async executeResponseInterceptors(response) {
    let resp = deepClone(response);
    for (const interceptor of this.responseInterceptors) {
      resp = await interceptor(resp);
    }
    return resp;
  },
  
  /**
   * Execute error interceptors
   * @param {Error} error - Error object
   * @returns {Error} Modified error
   */
  async executeErrorInterceptors(error) {
    let err = error;
    for (const interceptor of this.errorInterceptors) {
      err = await interceptor(err);
    }
    return err;
  },
  
  /**
   * Clear all interceptors
   */
  clearAll() {
    this.requestInterceptors = [];
    this.responseInterceptors = [];
    this.errorInterceptors = [];
  },
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Format error message
 * @param {Error|string} error - Error object or message
 * @returns {string} Formatted error message
 */
function formatError(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Create a custom error
 * @param {string} type - Error type
 * @param {string} message - Error message
 * @param {*} details - Error details
 * @returns {Error} Custom error object
 */
function createError(type, message, details = null) {
  const error = new Error(message);
  error.type = type;
  error.details = details;
  error.timestamp = new Date().toISOString();
  return error;
}

/**
 * Retry function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} maxAttempts - Maximum attempts
 * @param {number} initialDelay - Initial delay in milliseconds
 * @returns {Promise<*>} Result of the function
 */
async function retry(fn, maxAttempts = 3, initialDelay = 1000) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt < maxAttempts) {
        const delay = initialDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Timeout wrapper for promises
 * @param {Promise} promise - Promise to wrap
 * @param {number} ms - Timeout in milliseconds
 * @returns {Promise<*>} Result or timeout error
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(createError(
        CONSTANTS.ERROR_TYPES.TIMEOUT_ERROR,
        `Operation timed out after ${ms}ms`
      )), ms)
    ),
  ]);
}

/**
 * Validate required fields
 * @param {Object} obj - Object to validate
 * @param {Array<string>} requiredFields - Required field names
 * @returns {Object} Validation result { valid: boolean, errors: Array }
 */
function validateRequired(obj, requiredFields) {
  const errors = [];
  
  for (const field of requiredFields) {
    if (isEmpty(obj[field])) {
      errors.push(`Field "${field}" is required`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Convert object to query string
 * @param {Object} params - Parameters object
 * @returns {string} Query string
 */
function objectToQueryString(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

/**
 * Parse query string to object
 * @param {string} queryString - Query string
 * @returns {Object} Parameters object
 */
function queryStringToObject(queryString) {
  const params = {};
  const searchParams = new URLSearchParams(queryString);
  
  for (const [key, value] of searchParams) {
    params[key] = value;
  }
  
  return params;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants and Configuration
  CONSTANTS,
  CONFIG,
  
  // Utilities
  deepClone,
  deepMerge,
  isEmpty,
  safeJsonParse,
  safeJsonStringify,
  generateId,
  debounce,
  throttle,
  
  // Network Hooks
  networkHooks,
  
  // Helper Functions
  formatError,
  createError,
  retry,
  withTimeout,
  validateRequired,
  objectToQueryString,
  queryStringToObject,
};
