function required(name: string): () => string {
  return () => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not configured`);
    return value;
  };
}

export const env = {
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  ebayClientId: required("EBAY_CLIENT_ID"),
  ebayClientSecret: required("EBAY_CLIENT_SECRET"),
  databaseUrl: required("DATABASE_URL"),
};

export const isAnthropicConfigured = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY);
export const isEbayConfigured = (): boolean =>
  Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
export const isDbConfigured = (): boolean => Boolean(process.env.DATABASE_URL);
