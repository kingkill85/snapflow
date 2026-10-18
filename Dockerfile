# syntax=docker/dockerfile:1

FROM node:22-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.26-alpine AS backend
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/snapflow ./cmd/snapflow

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=backend /out/snapflow /snapflow
COPY --from=frontend /src/frontend/dist /web
ENV PORT=8000 STATIC_DIR=/web
EXPOSE 8000
ENTRYPOINT ["/snapflow"]
CMD ["serve"]
