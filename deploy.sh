#!/bin/bash
# ZDF.AI 腾讯云部署脚本
# 用法：在服务器上执行 bash deploy.sh
# 首次部署约需 5 分钟

set -e

DOMAIN="zdfai.site"
APP_DIR="/var/www/zdfai"
REPO="https://github.com/lingxiao1982/zdf-ai-platform_deployment.git"

echo "=== [1/6] 安装系统依赖 ==="
apt-get update -y
apt-get install -y curl git nginx certbot python3-certbot-nginx

echo "=== [2/6] 安装 Node.js 20 ==="
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
node -v && npm -v

echo "=== [3/6] 安装 PM2 ==="
npm install -g pm2

echo "=== [4/6] 拉取代码 ==="
if [ -d "$APP_DIR" ]; then
    cd "$APP_DIR" && git pull
else
    git clone "$REPO" "$APP_DIR"
    cd "$APP_DIR"
fi

echo "=== [5/6] 安装依赖 & 构建前端 ==="
cd "$APP_DIR/zdf-ai-platform"
npm install
npm run build
cd backend && npm install && cd ..

echo "=== [6/6] 启动 / 重启服务 ==="
pm2 start ecosystem.config.cjs || pm2 restart zdf-ai-platform
pm2 save
pm2 startup | tail -1 | bash || true

echo ""
echo "=== 配置 Nginx ==="
cp "$APP_DIR/nginx.conf" "/etc/nginx/sites-available/$DOMAIN"
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "=== 申请 SSL 证书（Let's Encrypt） ==="
certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" || \
    echo "[警告] SSL 申请失败，请确认域名已解析到本机 IP 后重新运行：certbot --nginx -d $DOMAIN -d www.$DOMAIN"

echo ""
echo "=============================="
echo " 部署完成！"
echo " 访问：https://$DOMAIN"
echo " 查看日志：pm2 logs zdf-ai-platform"
echo " 重启服务：pm2 restart zdf-ai-platform"
echo "=============================="
