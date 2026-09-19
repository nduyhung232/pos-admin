// Isolate the TLS trust problem: try to fetch the exact Prisma URL and print the
// precise error, so we know whether NODE_EXTRA_CA_CERTS is being honoured.
const url =
  'https://binaries.prisma.sh/all_commits/605197351a3c8bdd595af2d2a9bc3025bca48ea2/windows/schema-engine.exe.sha256';
console.log('NODE_EXTRA_CA_CERTS =', process.env.NODE_EXTRA_CA_CERTS || '(unset)');
try {
  const r = await fetch(url);
  console.log('OK status', r.status);
} catch (e) {
  console.log('FETCH_FAIL', e.cause?.code || e.code || e.message);
}
