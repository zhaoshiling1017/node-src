'use strict';

const net = require('net');
const url = require('url');
const binding = process.binding('crypto');
const Buffer = require('buffer').Buffer;
const constants = require('constants');

// Allow {CLIENT_RENEG_LIMIT} client-initiated session renegotiations
// every {CLIENT_RENEG_WINDOW} seconds. An error event is emitted if more
// renegotations are seen. The settings are applied to all remote client
// connections.
exports.CLIENT_RENEG_LIMIT = 3;
exports.CLIENT_RENEG_WINDOW = 600;

exports.SLAB_BUFFER_SIZE = 10 * 1024 * 1024;

exports.DEFAULT_CIPHERS = constants.defaultCipherList;

exports.DEFAULT_ECDH_CURVE = 'prime256v1';

exports.getCiphers = function() {
  const names = binding.getSSLCiphers();
  // Drop all-caps names in favor of their lowercase aliases,
  var ctx = {};
  names.forEach(function(name) {
    if (/^[0-9A-Z\-]+$/.test(name)) name = name.toLowerCase();
    ctx[name] = true;
  });
  return Object.getOwnPropertyNames(ctx).sort();
};

// Convert protocols array into valid OpenSSL protocols list
// ("\x06spdy/2\x08http/1.1\x08http/1.0")
exports.convertNPNProtocols = function convertNPNProtocols(NPNProtocols, out) {
  // If NPNProtocols is Array - translate it into buffer
  if (Array.isArray(NPNProtocols)) {
    var buff = new Buffer(NPNProtocols.reduce(function(p, c) {
      return p + 1 + Buffer.byteLength(c);
    }, 0));

    NPNProtocols.reduce(function(offset, c) {
      var clen = Buffer.byteLength(c);
      buff[offset] = clen;
      buff.write(c, offset + 1);

      return offset + 1 + clen;
    }, 0);

    NPNProtocols = buff;
  }

  // If it's already a Buffer - store it
  if (NPNProtocols instanceof Buffer) {
    out.NPNProtocols = NPNProtocols;
  }
};

function unfqdn(host) {
  return host.replace(/[.]$/, '');
}

function splitHost(host) {
  // String#toLowerCase() is locale-sensitive so we use
  // a conservative version that only lowercases A-Z.
  const replacer = (c) => String.fromCharCode(32 + c.charCodeAt(0));
  return unfqdn(host).replace(/[A-Z]/g, replacer).split('.');
}

function check(hostParts, pattern, wildcards) {
  // Empty strings, null, undefined, etc. never match.
  if (!pattern)
    return false;

  const patternParts = splitHost(pattern);

  if (hostParts.length !== patternParts.length)
    return false;

  // Pattern has empty components, e.g. "bad..example.com".
  if (patternParts.indexOf('') !== -1)
    return false;

  // RFC 6125 allows IDNA U-labels (Unicode) in names but we have no
  // good way to detect their encoding or normalize them so we simply
  // reject them.  Control characters and blanks are rejected as well
  // because nothing good can come from accepting them.
  const isBad = (s) => /[^\u0021-\u007F]/.test(s);
  if (patternParts.some(isBad))
    return false;

  // Check host parts from right to left first.
  for (let i = hostParts.length - 1; i > 0; i -= 1)
    if (hostParts[i] !== patternParts[i])
      return false;

  const hostSubdomain = hostParts[0];
  const patternSubdomain = patternParts[0];
  const patternSubdomainParts = patternSubdomain.split('*');

  // Short-circuit when the subdomain does not contain a wildcard.
  // RFC 6125 does not allow wildcard substitution for components
  // containing IDNA A-labels (Punycode) so match those verbatim.
  if (patternSubdomainParts.length === 1 ||
      patternSubdomain.indexOf('xn--') !== -1) {
    return hostSubdomain === patternSubdomain;
  }


  if (!wildcards)
    return false;

  // More than one wildcard is always wrong.
  if (patternSubdomainParts.length > 2)
    return false;

  // *.tld wildcards are not allowed.
  if (patternParts.length <= 2)
    return false;

  const prefix = patternSubdomainParts[0];
  const suffix = patternSubdomainParts[1];

  if (prefix.length + suffix.length > hostSubdomain.length)
    return false;

  if (!hostSubdomain.startsWith(prefix))
    return false;

  if (!hostSubdomain.endsWith(suffix))
    return false;

  return true;
}

exports.checkServerIdentity = function checkServerIdentity(host, cert) {
  const subject = cert.subject;
  const altNames = cert.subjectaltname;
  const dnsNames = [];
  const uriNames = [];
  const ips = [];

  host = '' + host;

  if (altNames) {
    for (const name of altNames.split(', ')) {
      if (name.startsWith('DNS:')) {
        dnsNames.push(name.slice(4));
      } else if (name.startsWith('URI:')) {
        const uri = url.parse(name.slice(4));
        uriNames.push(uri.hostname);  // TODO(bnoordhuis) Also use scheme.
      } else if (name.startsWith('IP Address:')) {
        ips.push(name.slice(11));
      }
    }
  }

  let valid = false;
  let reason = 'Unknown reason';

  if (net.isIP(host)) {
    valid = ips.indexOf(host) !== -1;
    if (!valid)
      reason = `IP: ${host} is not in the cert's list: ${ips.join(', ')}`;
    // TODO(bnoordhuis) Also check URI SANs that are IP addresses.
  } else if (subject) {
    host = unfqdn(host);  // Remove trailing dot for error messages.
    const hostParts = splitHost(host);
    const wildcard = (pattern) => check(hostParts, pattern, true);
    const noWildcard = (pattern) => check(hostParts, pattern, false);

    // Match against Common Name only if no supported identifiers are present.
    if (dnsNames.length === 0 && ips.length === 0 && uriNames.length === 0) {
      const cn = subject.CN;

      if (Array.isArray(cn))
        valid = cn.some(wildcard);
      else if (cn)
        valid = wildcard(cn);

      if (!valid)
        reason = `Host: ${host}. is not cert's CN: ${cn}`;
    } else {
      valid = dnsNames.some(wildcard) || uriNames.some(noWildcard);
      if (!valid)
        reason = `Host: ${host}. is not in the cert's altnames: ${altNames}`;
    }
  } else {
    reason = 'Cert is empty';
  }

  if (!valid) {
    const err = new Error(
        `Hostname/IP doesn't match certificate's altnames: "${reason}"`);
    err.reason = reason;
    err.host = host;
    err.cert = cert;
    return err;
  }
};

// Example:
// C=US\nST=CA\nL=SF\nO=Joyent\nOU=Node.js\nCN=ca1\nemailAddress=ry@clouds.org
exports.parseCertString = function parseCertString(s) {
  var out = {};
  var parts = s.split('\n');
  for (var i = 0, len = parts.length; i < len; i++) {
    var sepIndex = parts[i].indexOf('=');
    if (sepIndex > 0) {
      var key = parts[i].slice(0, sepIndex);
      var value = parts[i].slice(sepIndex + 1);
      if (key in out) {
        if (!Array.isArray(out[key])) {
          out[key] = [out[key]];
        }
        out[key].push(value);
      } else {
        out[key] = value;
      }
    }
  }
  return out;
};

// Public API
exports.createSecureContext = require('_tls_common').createSecureContext;
exports.SecureContext = require('_tls_common').SecureContext;
exports.TLSSocket = require('_tls_wrap').TLSSocket;
exports.Server = require('_tls_wrap').Server;
exports.createServer = require('_tls_wrap').createServer;
exports.connect = require('_tls_wrap').connect;
exports.createSecurePair = require('_tls_legacy').createSecurePair;
