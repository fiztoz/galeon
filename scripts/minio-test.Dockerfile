# syntax=docker/dockerfile:1
# Official upstream source, pinned independently of discontinued public images.
# MinIO RELEASE.2025-10-15T17-29-55Z; mc RELEASE.2025-08-13T08-35-41Z.
FROM golang:1.24.9-bookworm AS minio-build
WORKDIR /src
RUN --mount=type=secret,id=ca_bundle \
    if [ -f /run/secrets/ca_bundle ]; then \
      export SSL_CERT_FILE=/run/secrets/ca_bundle GIT_SSL_CAINFO=/run/secrets/ca_bundle; \
    fi && \
    git init && git remote add origin https://github.com/minio/minio.git && \
    git fetch --depth=1 origin 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a && \
    git checkout --detach FETCH_HEAD && \
    CGO_ENABLED=0 go build -p 2 -trimpath -o /out/minio .

FROM golang:1.24.9-bookworm AS mc-build
WORKDIR /src
RUN --mount=type=secret,id=ca_bundle \
    if [ -f /run/secrets/ca_bundle ]; then \
      export SSL_CERT_FILE=/run/secrets/ca_bundle GIT_SSL_CAINFO=/run/secrets/ca_bundle; \
    fi && \
    git init && git remote add origin https://github.com/minio/mc.git && \
    git fetch --depth=1 origin 7394ce0dd2a80935aded936b09fa12cbb3cb8096 && \
    git checkout --detach FETCH_HEAD && \
    CGO_ENABLED=0 go build -p 2 -trimpath -o /out/mc .

FROM debian:bookworm-slim
COPY --from=minio-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=minio-build /out/minio /usr/local/bin/minio
COPY --from=mc-build /out/mc /usr/local/bin/mc
ENTRYPOINT ["minio"]
