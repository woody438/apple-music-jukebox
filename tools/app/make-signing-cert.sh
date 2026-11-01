#!/usr/bin/env bash
# Makes the certificate GitHub signs Party Jukebox with, so macOS sees every
# build as the same app and "Party Jukebox wants to control Music" is asked
# once, not after every update. Without it each build is signed ad hoc,
# looks new to macOS, has to be allowed again -- and cannot update itself.
# (Adapted from busy-bar-sign's tools/make-signing-cert.sh.)
#
# Run it once, on your Mac:
#   curl -fsSL https://raw.githubusercontent.com/woody438/apple-music-jukebox/main/tools/app/make-signing-cert.sh | bash
# It copies the certificate (base64) to the clipboard and prints its password.
# On GitHub, woody438/apple-music-jukebox > Settings > Secrets and variables >
# Actions > New repository secret:
#   SIGNING_CERT_P12        paste the clipboard
#   SIGNING_CERT_PASSWORD   the password it printed
# Keep a copy of both in a password manager. A new certificate later means
# every copy has to be re-downloaded by hand once, and asked about Music again.
#
# It's self-signed: Apple doesn't vouch for it, so the first open still needs
# Open Anyway. Keep the secrets secret -- anyone with them could sign an app
# macOS would take for Party Jukebox.
#
#   tools/app/make-signing-cert.sh OUT.p12   writes the .p12 there and prints
#                                            only the password (CI's own test)
set -euo pipefail
OPENSSL=/usr/bin/openssl                 # macOS's own (LibreSSL): a .p12 the keychain imports
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
PASS=$("$OPENSSL" rand -hex 16)

cat > "$DIR/cert.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Party Jukebox
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF

"$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 -config "$DIR/cert.cnf" \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" 2>/dev/null
"$OPENSSL" pkcs12 -export -inkey "$DIR/key.pem" -in "$DIR/cert.pem" -name "Party Jukebox" \
  -out "$DIR/cert.p12" -passout "pass:$PASS"

if [ $# -ge 1 ]; then
  cp "$DIR/cert.p12" "$1"
  echo "$PASS"
  exit 0
fi

base64 -i "$DIR/cert.p12" | tr -d '\n' | pbcopy
cat <<EOF

The certificate is on the clipboard. On GitHub, woody438/apple-music-jukebox >
Settings > Secrets and variables > Actions > New repository secret:

  SIGNING_CERT_P12        paste (Cmd-V)
  SIGNING_CERT_PASSWORD   $PASS

Keep a copy of both somewhere safe.
EOF
