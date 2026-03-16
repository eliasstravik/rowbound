/** Default pipeline settings used during initialization. */
export const defaultSettings = {
    concurrency: 1,
    rateLimit: 10,
    retryAttempts: 3,
    retryBackoff: "exponential",
};
