FROM rust:1.85-bookworm

ARG BUN_VERSION=1.3.9
ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:/root/.cargo/bin:${PATH}

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates openssl build-essential pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION}

WORKDIR /app
COPY . .

RUN bun install --frozen-lockfile
RUN bun run build:native
RUN mkdir -p examples/compose-collab/certs \
  && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 10 -nodes \
     -keyout examples/compose-collab/certs/key.pem \
     -out examples/compose-collab/certs/cert.pem \
     -subj '/CN=localhost' \
     -addext 'subjectAltName = DNS:localhost,IP:127.0.0.1'

CMD ["bun", "run", "examples/compose-collab/server.ts"]
