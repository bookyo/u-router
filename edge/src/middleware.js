'use strict';

// async 路由兜底，把异常交给 express 错误中间件
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { ah };
