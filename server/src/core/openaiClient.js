const OpenAI = require("openai");
const { config } = require("../config");

const clientOptions = {
  apiKey: config.openai.apiKey,
  timeout: config.openai.timeout,
};
if (config.openai.baseUrl) {
  clientOptions.baseURL = config.openai.baseUrl;
}

const openai = new OpenAI(clientOptions);

const llmCapabilities = {
  supportsContainers: config.openai.provider === "openai",
};

module.exports = { openai, llmCapabilities };

