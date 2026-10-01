'use strict';
// نقطة دخول واحدة لكل مسارات /api/* (يوفّر عدد Functions في خطة Vercel المجانية).
const { handle } = require('../server/routes');

module.exports = async function handler(req, res) {
  return handle(req, res);
};
