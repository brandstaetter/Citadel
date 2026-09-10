# Compatibility entrypoint. The Node runner owns permissions, limits and state checks.
& node (Join-Path $PSScriptRoot 'local-daemon.js') @args
exit $LASTEXITCODE
