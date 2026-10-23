FROM mcr.microsoft.com/playwright:v1.64.1-noble
ENV NODE_ENV=production PORT=10000 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
EXPOSE 10000
CMD ["npm", "start"]