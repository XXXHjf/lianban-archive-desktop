# 行业来源中间证书

`geotrust-g2-cn-2022-ca1.crt` 是公开的 DigiCert / GeoTrust 中间 CA 证书，不含私钥。申万研究文件站点在 2026-10-17 的 TLS 响应中没有附带这张中间证书，Linux 因此无法构建到系统受信任根的完整链。

来源是站点叶证书 Authority Information Access 标明的发行者地址：

<http://cacerts.digicert.cn/GeoTrustG2TLSCNRSA4096SHA2562022CA1.crt>

原文件为 DER；本项目保存等价的 PEM 编码。2026-10-17 在香港 Ubuntu 24.04 上使用 `openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt issuer.crt` 验证为 OK；本机副本与该已验证文件 SHA-256 完全一致：

```text
2182efcbf5b27c34ba8901fae4715a6c6bdc54d9e186adc7b43523ce2e9176c1
```

仅在行业文件请求的独立 SSLContext 中补充发行者，不修改系统信任库；仍检查主机名、有效期、完整链及系统根信任。关闭 `VERIFY_X509_PARTIAL_CHAIN`，不把中间证书作为独立信任根。其余来源保留原有验证方式。已从香港服务器在完整校验下确认官方字典文件返回 HTTP 200。
