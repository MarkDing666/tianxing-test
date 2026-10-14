# 天性光谱 · Spectrum

性格 × 职业兴趣测试（大五人格 + 霍兰德六边形）。

- `public/index.html`：测试页面（免费看角色，测试码解锁完整报告）
- `public/admin.html`：测试码管理页（访问 /admin，需要管理密钥）
- `src/worker.js`：Cloudflare Worker，测试码的兑换、校验与管理接口
- 测试码存放在 Durable Object（SQLite）里，首次使用后 7 天有效，绑定一台设备

© KKMEFLICKER
