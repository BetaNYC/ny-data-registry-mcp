# Extra certificates for the harvest

The harvest workflow passes the files here to Node with `NODE_EXTRA_CA_CERTS`
([Node docs](https://nodejs.org/docs/latest-v22.x/api/cli.html#node_extra_ca_certsfile)). That
adds certificates to Node's built-in list of trusted ones. Certificate checks stay on for every
host. Nothing here is a root certificate, and nothing turns verification off.

## `sectigo-public-server-authentication-ca-ov-r36.pem`

**Why it is here.** Orange County's GIS server, `gis.orangecountygov.com`, sends its own
certificate but not the intermediate certificate that signed it. Browsers often fetch the missing
piece themselves; Node does not, so every request failed with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
and the county's portal was left out of the index. With this one public intermediate added, Node
can check the county's certificate all the way up to a root it already trusts.

**What it is.**

| | |
|---|---|
| Subject | `C=GB, O=Sectigo Limited, CN=Sectigo Public Server Authentication CA OV R36` |
| Issuer | `C=GB, O=Sectigo Limited, CN=Sectigo Public Server Authentication Root R46` |
| Serial | `2C1A3C76E943DDDDFF191B31890AED71` |
| SHA-256 | `65:42:D1:76:BE:D5:0F:19:3C:0C:E2:97:AE:44:EC:D8:A0:A8:6B:EC:2E:DE:68:27:69:34:40:59:B4:E7:85:30` |
| SHA-1 | `32:1C:A0:56:E4:E4:8D:57:F1:79:A3:BD:DE:CB:C5:21:3B:99:16:C0` |
| Valid | 2021-03-22 to 2036-03-21 |

**Where it came from and how it was checked (2026-11-13).**

1. One TLS handshake with `gis.orangecountygov.com:443` showed a chain of one certificate:
   `CN=*.orangecountygov.com`, issued by `Sectigo Public Server Authentication CA OV R36`, valid
   to 2027-03-05, Authority Key Identifier `E3:66:74:BB:70:68:8D:2C:5D:4E:0E:A6:4A:8F:9B:37:22:9C:82:92`.
2. That certificate's own "CA Issuers" address (Authority Information Access) is
   `http://crt.sectigo.com/SectigoPublicServerAuthenticationCAOVR36.crt`, Sectigo's server. The file
   was downloaded from there and converted from DER to PEM. Nothing else was changed.
3. Its Subject Key Identifier matches the county certificate's Authority Key Identifier, and the
   county certificate's signature checks against its key.
4. Its signature checks against `Sectigo Public Server Authentication Root R46`, which is in Node's
   bundled root list (Node 22.16.0 and 26.13.1 both checked), and `openssl verify` against that
   list passes for both certificates.
5. Certificate Transparency has it: [crt.sh ID 4267304698](https://crt.sh/?id=4267304698), same
   SHA-256, logged 2021-03-24, not revoked in Mozilla OneCRL or Microsoft's disallowed list.

`test/publish.test.mjs` checks steps 3 and 4 offline on every test run, and pins the SHA-256.

**When to remove it.** As soon as the county's server sends its full chain. Check with:

```sh
echo | openssl s_client -connect gis.orangecountygov.com:443 -servername gis.orangecountygov.com 2>/dev/null | grep -c ' s:'
```

A count of 2 or more means the intermediate is now sent. Then delete this file, its line in
`.github/workflows/harvest.yml`, and its test.
