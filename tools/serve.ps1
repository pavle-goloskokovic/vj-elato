# Static file server with HTTP Range support, for Windows machines without Python.
# Pure PowerShell 5.1, no install, no admin (localhost prefixes need no URL ACL).
#   powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1 [-Port 8765]
param([int]$Port = 8765)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://localhost:$Port/"

$handler = {
  param($ctx, $root)
  $mime = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript'; '.css' = 'text/css'; '.json' = 'application/json';
             '.mp4' = 'video/mp4'; '.m4v' = 'video/mp4'; '.webm' = 'video/webm'; '.mov' = 'video/quicktime'; '.mkv' = 'video/x-matroska';
             '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.png' = 'image/png'; '.webp' = 'image/webp'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon';
             '.md' = 'text/plain; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8' }
  $req = $ctx.Request; $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path.EndsWith('/')) { $path += 'index.html' }
    $full = [IO.Path]::GetFullPath((Join-Path $root ($path.TrimStart('/') -replace '/', '\')))
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $res.StatusCode = 404; $res.Close(); return
    }
    $ext = [IO.Path]::GetExtension($full).ToLower()
    $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
    $res.AddHeader('Accept-Ranges', 'bytes')
    $res.AddHeader('Cache-Control', 'no-cache')
    $fs = [IO.File]::Open($full, 'Open', 'Read', 'ReadWrite')
    $len = $fs.Length; $start = [long]0; $end = $len - 1
    $range = $req.Headers['Range']
    if ($range -and $range -match 'bytes=(\d*)-(\d*)') {
      if ($Matches[1]) { $start = [long]$Matches[1]; if ($Matches[2]) { $end = [long]$Matches[2] } }
      elseif ($Matches[2]) { $start = [Math]::Max(0, $len - [long]$Matches[2]) }
      if ($end -ge $len) { $end = $len - 1 }
      $res.StatusCode = 206
      $res.AddHeader('Content-Range', "bytes $start-$end/$len")
    }
    $count = $end - $start + 1
    $res.ContentLength64 = $count
    $fs.Position = $start
    $buf = New-Object byte[] 65536
    while ($count -gt 0) {
      $n = $fs.Read($buf, 0, [int][Math]::Min($buf.Length, $count))
      if ($n -le 0) { break }
      $res.OutputStream.Write($buf, 0, $n); $count -= $n
    }
    $fs.Close(); $res.Close()
  } catch {
    try { $res.Abort() } catch {}
  }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
$listener.Start()
Write-Host "VJ Elato: serving $root"
Write-Host "  $url   (Ctrl+C to stop)"
Start-Process $url | Out-Null

# requests are handled on a runspace pool so several video streams can be served at once
$pool = [RunspaceFactory]::CreateRunspacePool(1, 8); $pool.Open()
$jobs = New-Object System.Collections.ArrayList
try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $ps = [PowerShell]::Create(); $ps.RunspacePool = $pool
    [void]$ps.AddScript($handler).AddArgument($ctx).AddArgument($root)
    [void]$jobs.Add(@{ ps = $ps; h = $ps.BeginInvoke() })
    for ($i = $jobs.Count - 1; $i -ge 0; $i--) { if ($jobs[$i].h.IsCompleted) { $jobs[$i].ps.Dispose(); $jobs.RemoveAt($i) } }
  }
} finally {
  $listener.Stop(); $pool.Close()
}
