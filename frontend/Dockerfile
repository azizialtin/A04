# Build the SPA, then serve the static bundle from nginx.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:1.27-alpine
# The image's entrypoint renders anything in templates/ with envsubst, so the
# policy can name the real backend at deploy time.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

# Defaults suit the local stack. In production set CSP_POLICY with the backend
# origin in connect-src, and the bucket host in media-src if videos are served
# from signed GCS urls.
ENV CSP_POLICY="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob: http://localhost:8030; connect-src 'self' http://localhost:8030 ws://localhost:8765; frame-src https://www.soscisurvey.de; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

EXPOSE 80
