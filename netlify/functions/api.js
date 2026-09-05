'use strict';

const serverless = require('serverless-http');
const app = require('../../server');

// netlify.toml のリダイレクトで /.netlify/functions/api/api/:splat に
// 転送しているため、この関数のベースパス（/.netlify/functions/api）を
// 取り除くと、Expressアプリ側が期待する /api/... のパスと一致する。
exports.handler = serverless(app, {
  basePath: '/.netlify/functions/api',
});
