# Runbook — bringing `v-ubuntu-loadgen` up for the off-box RTT gate

**For:** the orchestrator, or whoever dispatches
`docs/research/preregistrations/gate-g2-offbox-rtt.md`.
**Written by:** the design agent for ticket 25, which **did not power anything
on**. Every command below is written to be run by a human or an orchestrator that
holds the authority to change the state of the home lab; nothing here has been
executed.

## The three hosts

| role | name | how you reach it | address that matters |
|---|---|---|---|
| Hyper-V host | `home-windows` | ssh alias (Tailscale `100.72.254.21`, key `~/.ssh/ubuntu-vm-hermes`) | control plane only |
| server / CI runner | `home-ubuntu` = guest `v-ubuntu-home` | ssh alias (Tailscale `100.68.152.116`) | **LAN `192.168.2.35`, `eth0`** |
| load generator | guest `v-ubuntu-loadgen` | from the runner: `hermes-admin@192.168.2.36` | **LAN `192.168.2.36`** |

**Control plane over Tailscale is fine. The data path must be `192.168.2.x` and
never `100.x`.** The conductor refuses to start if the dialled host is not
`192.168.2.*` (registration §11.2); Wi-Fi and Tailscale generation are both
already falsified (7.4k pps / 3.3k pps respectively, ceiling-attribution doc).

## Step 1 — host RAM check. Do this before `Start-VM`, every time.

The loadgen is **1280 MB static** (no dynamic memory). The Windows host runs with
roughly 1 GB of slack. **Two previous attempts failed because the VM was started
without checking.** The check is not optional and its threshold is not a
suggestion.

```bash
ssh home-windows powershell -NoProfile -Command \
  "\$os = Get-CimInstance Win32_OperatingSystem; \
   [pscustomobject]@{ FreeMB=[int](\$os.FreePhysicalMemory/1KB); TotalMB=[int](\$os.TotalVisibleMemorySize/1KB) } | Format-List"
```

```bash
ssh home-windows powershell -NoProfile -Command \
  "Get-VM | Select-Object Name,State,@{n='AssignedMB';e={[int](\$_.MemoryAssigned/1MB)}},@{n='StartupMB';e={[int](\$_.MemoryStartup/1MB)}} | Format-Table -AutoSize"
```

**Go / no-go:** proceed only if `FreeMB >= 1536` (1280 static + 256 headroom).

If it is below 1536, **do not start the VM.** Free memory on the host first — the
usual candidate is another guest that is running and not needed, which
`Get-VM` above will show. Starting into insufficient host memory is what failed
before; a failed start is not a rig fault worth spending a dispatch on.

Also confirm from that same `Get-VM` output that the guest is named exactly
`v-ubuntu-loadgen` and that its `State` is `Off`.

## Step 2 — power on

```bash
ssh home-windows powershell -NoProfile -Command "Start-VM -Name v-ubuntu-loadgen"
ssh home-windows powershell -NoProfile -Command \
  "Get-VM -Name v-ubuntu-loadgen | Select-Object Name,State,@{n='AssignedMB';e={[int](\$_.MemoryAssigned/1MB)}} | Format-List"
```

`AssignedMB` should read 1280. If it reads 0 while `State` is `Running`, the host
could not back the allocation — stop, and go back to step 1.

## Step 3 — wait for the guest, from the runner (not from your laptop)

The runner is the machine that has to reach it. Run the wait loop there:

```bash
ssh home-ubuntu 'for i in $(seq 1 60); do \
    if ssh -o BatchMode=yes -o ConnectTimeout=5 hermes-admin@192.168.2.36 true 2>/dev/null; then \
      echo "loadgen up after ${i}0s"; exit 0; fi; sleep 10; done; echo "loadgen did not come up"; exit 1'
```

## Step 4 — pre-flight the generator host and the path, from the runner

```bash
ssh home-ubuntu 'ssh -o BatchMode=yes hermes-admin@192.168.2.36 \
  "hostname; uname -m; nproc; free -m | head -2; ip -4 -o addr show | awk \"{print \\\$2, \\\$4}\""'
```

Expect: 3 CPUs, ~1280 MB total, an address in `192.168.2.0/24`, and `uname -m`
equal to the runner's (`x86_64`) — the conductor refuses on an architecture
mismatch, because it `scp`s a release binary built on the runner.

Idle path RTT, recorded as context for the registration's `wireCostP99Ns`:

```bash
ssh home-ubuntu 'ping -c 200 -i 0.05 -q 192.168.2.36'
```

Confirm the runner's LAN route to the generator is `eth0` and not a bridge or the
Tailscale interface:

```bash
ssh home-ubuntu 'ip route get 192.168.2.36'
```

Nothing else should be loading either guest. Check both:

```bash
ssh home-ubuntu 'uptime; pgrep -a -f "load-client|bench-latency" || echo "runner clean"'
ssh home-ubuntu 'ssh -o BatchMode=yes hermes-admin@192.168.2.36 "uptime; pgrep -a load-client || echo loadgen clean"'
```

Any stray `load-client` from an earlier dispatch must be killed before starting;
the conductor also `pkill`s remotely before each off-box cell, but a straggler
that survives the check is a confound.

## Step 5 — dispatch

The candidate SHA comes from git, never from a keyboard:

```bash
cd <repo> && git rev-parse probe/latency-rtt-01     # or: git ls-remote origin probe/latency-rtt-01
```

The branch must be pushed before dispatch (the workflow checks the SHA out), and
the dispatch is:

```bash
gh workflow run bench-bandwidth.yml \
  -f candidate_commit=<sha from git> \
  -f latency_rtt=true \
  -f sessions=100 \
  -f payload_bytes=1150
```

Two GitHub input gotchas that have already cost this effort a run each:

- a whitespace-only value for a string input is replaced by the input's declared
  default (G4 lost its suppression that way) — never pass `" "` to mean "off";
- the workflow's concurrency group holds exactly **one** queued run; a second
  dispatch cancels the first.

Watch it, and keep the run id — it goes in the registration's dispatch log along
with the candidate SHA and the artifact hash, **including if it aborts**:

```bash
gh run watch <run-id>
gh run download <run-id> -n bench-latency-rtt-<sha>
```

## Step 6 — power off when the dispatch is done

The loadgen holds 1280 MB of a host that has about 1 GB of slack. Leaving it
running is what makes the *next* thing on this lab fail.

```bash
ssh home-windows powershell -NoProfile -Command "Stop-VM -Name v-ubuntu-loadgen"
ssh home-windows powershell -NoProfile -Command \
  "Get-VM -Name v-ubuntu-loadgen | Select-Object Name,State | Format-List"
```

`Stop-VM` without `-Force` asks the guest to shut down cleanly. If it hangs, look
at the guest before reaching for `-Force`; a generator that will not shut down is
usually a `load-client` that is still running, which is itself worth knowing.

## If it goes wrong

| symptom | what it means | what to do |
|---|---|---|
| `Start-VM` fails on memory | host slack was below the VM's static 1280 MB | step 1's threshold was skipped or something started in between. Free host memory; do not retry blindly. |
| step 3 never sees ssh | guest booted without network, or the key is not on it | check `Get-VM` state and the guest console on the host; the runner→loadgen key is what the CI job also uses, so this blocks the dispatch either way |
| conductor refuses with `urlHost` | the dispatch resolved a `100.x` or non-LAN address | fix the address; never let the data path onto Tailscale |
| cell 0 reports `offbox-unreachable` | UDP from the loadgen is not reaching the server port | firewall or route on the runner. This is a declared infra fault: the gate is INCOMPLETE and a re-dispatch is permitted once it is fixed and logged. |
| the run is INCOMPLETE for `path-not-quiet` | the virtual switch or the host was busy | check what else runs on the Windows host; re-dispatch is *not* automatically licensed — read registration §10 row 3 |
