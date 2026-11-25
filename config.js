const path = require("path");

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST || "127.0.0.1",
  IS_PROD: process.env.NODE_ENV === "production",
  DATA_DIR: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname,
  // Password hashing cost. Tests lower it so they run fast.
  BCRYPT_COST: Number(process.env.BCRYPT_COST) || 12,
  // Used when a number is typed in local form (0300...). Pakistan = 92
  DEFAULT_COUNTRY_CODE: (process.env.DEFAULT_COUNTRY_CODE || "92").replace(/\D/g, "")
};