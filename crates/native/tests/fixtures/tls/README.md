# TLS parser fixtures

Throwaway key material for `server_tls` unit tests. These keys are public in
git history and must never be used outside tests.

- `ec-cert.pem` / `ec-sec1.pem` — P-256 self-signed leaf plus its key in SEC1
  form (`BEGIN EC PRIVATE KEY`), the shape `openssl ecparam -genkey` emits.
- `ec-pkcs8.pem` — the same P-256 key re-encoded as PKCS#8
  (`BEGIN PRIVATE KEY`), the shape `openssl req -newkey ec -nodes` emits.
- `ec-other-sec1.pem` — an unrelated P-256 key, for the cert/key mismatch case.
- `rsa-cert.pem` / `rsa-key.pem` — RSA-2048 self-signed leaf plus PKCS#8 key.

Regenerate with:

```sh
openssl ecparam -name prime256v1 -genkey -noout -out ec-sec1.pem
openssl pkcs8 -topk8 -nocrypt -in ec-sec1.pem -out ec-pkcs8.pem
openssl req -x509 -key ec-sec1.pem -sha256 -days 3650 -out ec-cert.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost"
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
  -keyout rsa-key.pem -out rsa-cert.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost"
openssl ecparam -name prime256v1 -genkey -noout -out ec-other-sec1.pem
```

The certificates are long-lived on purpose: nothing here goes through a
validity check, only the key parser and the cert/key consistency check.
