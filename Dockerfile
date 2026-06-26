# shoom-backend/Dockerfile

FROM node:20-alpine AS builder

WORKDIR /app

# Копируем файлы зависимостей
COPY package*.json ./

# Устанавливаем зависимости (включая devDependencies для сборки TS).
# Реестр npmjs.org с RU-сервера нестабилен (ETIMEDOUT на части тарболлов, в т.ч.
# typescript → падал `npm ci` с "Exit handler never called"). Тянем через зеркало
# registry.npmmirror.com (как docker-hub зеркало в daemon.json). --include=dev на
# случай NODE_ENV=production в окружении сборки.
RUN npm ci --include=dev --no-audit --no-fund --registry=https://registry.npmmirror.com

# Копируем исходный код
COPY . .

# Собираем TypeScript в JavaScript (папка dist)
RUN npm run build

# --- Production Stage ---
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV production

# Копируем package.json для запуска
COPY package*.json ./

# Устанавливаем только production зависимости (меньше вес образа). Тоже через зеркало.
RUN npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com

# Копируем собранный код из builder
COPY --from=builder /app/dist ./dist

# Создаем пользователя (безопасность)
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Каталог для загруженных аватаров (монтируется как docker volume).
# Создаём с нужным владельцем — named volume унаследует права при первом монтировании.
RUN mkdir -p /app/uploads/avatars && chown -R nextjs:nodejs /app/uploads

USER nextjs

EXPOSE 3001

# Запускаем скомпилированный файл (проверь, что в package.json main указывает на dist/index.js)
CMD ["node", "dist/index.js"]
