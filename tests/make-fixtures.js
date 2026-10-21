// Generates the small, fictional fixtures used by smoke.spec.js and window.__demo.
// Run: node tests/make-fixtures.js
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'fixtures');

const compose = `# Fictional Docker Compose file for a made-up blog service
name: inkwell-blog
services:
  web:
    image: inkwell/web:2.4.1
    restart: unless-stopped
    ports:
      - "8080:80"
    environment: &common_env
      TZ: UTC
      LOG_LEVEL: info
      DATABASE_HOST: db
    depends_on:
      - db
  db:
    image: postgres:16-alpine
    environment:
      <<: *common_env
      POSTGRES_DB: inkwell
      POSTGRES_USER: blog_app
      POSTGRES_PASSWORD: change-me-example
    volumes:
      - blog-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "blog_app"]
      interval: 10s
      retries: 5
volumes:
  blog-data: {}
`;

const composeJson = {
  name: 'inkwell-blog',
  services: {
    web: {
      image: 'inkwell/web:2.4.1',
      restart: 'unless-stopped',
      ports: ['8080:80'],
      environment: { TZ: 'UTC', LOG_LEVEL: 'info', DATABASE_HOST: 'db' },
      depends_on: ['db'],
    },
    db: {
      image: 'postgres:16-alpine',
      environment: { TZ: 'UTC', LOG_LEVEL: 'info', DATABASE_HOST: 'db', POSTGRES_DB: 'inkwell', POSTGRES_USER: 'blog_app', POSTGRES_PASSWORD: 'change-me-example' },
      volumes: ['blog-data:/var/lib/postgresql/data'],
      healthcheck: { test: ['CMD', 'pg_isready', '-U', 'blog_app'], interval: '10s', retries: 5 },
    },
  },
  volumes: { 'blog-data': {} },
};

const multi = `# Two fictional Kubernetes-style documents
apiVersion: v1
kind: Service
metadata:
  name: inkwell-web
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inkwell-web
spec:
  replicas: 2
`;

const tab = 'server:\n  host: example.test\n\tport: 8080\n';

fs.writeFileSync(path.join(dir, 'compose.yaml'), compose);
fs.writeFileSync(path.join(dir, 'compose.json'), JSON.stringify(composeJson, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'multi.yaml'), multi);
fs.writeFileSync(path.join(dir, 'tab-indent.yaml'), tab);
console.log('fixtures written to', dir);
