#!/bin/bash
# ZDF.AI 腾讯云部署脚本
# 用法：在服务器上执行 bash deploy.sh
# 首次部署约需 5 分钟

set -euo pipefail

DOMAIN="zdfai.site"
APP_DIR="/var/www/zdfai"
REPO="https://github.com/lingxiao1982/zdf-ai-platform_deployment.git"

error_exit() {
  echo "[错误] $1" >&2
  exit 1
}

echo "=== [1/6] 安装系统依赖 ==="
apt-get update -y
apt-get install -y curl git nginx certbot python3-certbot-nginx || error_exit "系统依赖安装失败"

echo "=== [2/6] 安装 Node.js 20 ==="
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs || error_exit "Node.js 安装失败"
fi
node -v && npm -v

echo "=== [3/6] 安装 PM2 ==="
npm install -g pm2 || error_exit "PM2 安装失败"

echo "=== [4/6] 拉取代码 ==="
if [ -d "$APP_DIR" ]; then
    cd "$APP_DIR" && git pull || error_exit "代码拉取失败"
else
    git clone "$REPO" "$APP_DIR" || error_exit "代码克隆失败"
    cd "$APP_DIR"
fi

echo "=== [5/6] 安装依赖 & 构建前端 ==="
cd "$APP_DIR/zdf-ai-platform" || error_exit "项目目录不存在"
npm install || error_exit "前端依赖安装失败"
npm run build || error_exit "前端构建失败"
cd backend && npm install || error_exit "后端依赖安装失败"
cd ..

echo "=== [6/6] 启动 / 重启服务 ==="
if pm2 describe zdf-ai-platform >/dev/null 2>&1; then
    pm2 reload ecosystem.config.cjs || pm2 restart zdf-ai-platform || error_exit "PM2 重启服务失败"
else
    pm2 start ecosystem.config.cjs || error_exit "PM2 启动服务失败"
fi
pm2 save

# 仅在 systemd 可用且未配置时执行 PM2 自启脚本
if command -v systemctl &> /dev/null; then
    if ! systemctl is-enabled "pm2-${USER}" >/dev/null 2>&1; then
        echo "=== 配置 PM2 开机自启 ==="
        # 输出命令经校验后执行，避免直接 pipe 任意内容到 bash
        STARTUP_CMD=$(pm2 startup systemd -u "${USER}" --hp "${HOME}" 2>/dev/null | tail -n 1 || true)
        if [[ -n "$STARTUP_CMD" && "$STARTUP_CMD" == *"pm2 startup"* ]]; then
            bash -c "$STARTUP_CMD" || echo "[警告] PM2 开机自启配置失败，请手动执行: $STARTUP_CMD"
        else
            echo "[警告] 无法自动生成 PM2 自启命令，请手动运行: pm2 startup systemd -u ${USER} --hp ${HOME}"
        fi
    else
        echo "PM2 开机自启已配置，跳过"
    fi
fi

echo ""
echo "=== 配置 Nginx ==="
cp "$APP_DIR/nginx.conf" "/etc/nginx/sites-available/$DOMAIN"
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
rm -f /etc/nginx/sites-enabled/default
nginx -t || error_exit "Nginx 配置校验失败"
systemctl reload nginx || error_exit "Nginx 重载失败"

echo ""
echo "=== 申请 SSL 证书（Let's Encrypt） ==="
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    echo "SSL 证书已存在，跳过申请"
else
    certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" || \
        echo "[警告] SSL 申请失败，请确认域名已解析到本机 IP 后重新运行：certbot --nginx -d $DOMAIN -d www.$DOMAIN"
fi

echo ""
echo "=============================="
echo " 部署完成！"
echo " 访问：https://$DOMAIN"
echo " 查看日志：pm2 logs zdf-ai-platform"
echo " 重启服务：pm2 restart zdf-ai-platform"
echo "=============================="
