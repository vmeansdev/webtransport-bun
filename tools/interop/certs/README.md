# ECDSA certs for Chromium WebTransport interop

Generate with:
```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 10 -nodes \
  -keyout key.pem -out cert.pem \
  -subj '/CN=localhost' -addext "subjectAltName = DNS:localhost,IP:127.0.0.1"
```

SPKI hash (for serverCertificateHashes):
```bash
openssl x509 -in cert.pem -noout -pubkey | openssl pkey -pubin -outform DER 2>/dev/null | openssl dgst -sha256 -binary | base64
```
