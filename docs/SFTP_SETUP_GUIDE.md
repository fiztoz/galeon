# SFTP Setup Guide

This guide walks you through connecting to an SFTP server using Galeon, covering both SSH key and password authentication methods.

## Prerequisites

Before you begin, ensure you have:

1. **Galeon installed** - Download from the releases page or build from source
2. **SFTP server access** - You need:
   - Server hostname or IP address
   - SSH port (usually 22)
   - Username and password, OR
   - Username and SSH key pair
3. **Network access** - Ensure you can reach the server (no firewall blocking port 22)

## Option 1: SSH Key Authentication (Recommended)

SSH keys are more secure than passwords and don't require transmitting credentials over the network.

### Step 1: Generate an SSH Key

Galeon includes a built-in SSH key helper. Here's how to use it:

1. Open Galeon and select **SFTP / SSH** from the Protocol dropdown
2. Click **"Need an SSH key? Generate one"** below the authentication fields
3. Choose a key path (default: `~/.ssh/id_ed25519_galeon`)
4. Click **"Generate Key Pair"**
5. Copy the displayed public key

#### Alternative: Generate via Terminal

If you prefer the command line:

```bash
# Generate ed25519 key (recommended)
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_galeon -C "galeon@localhost"

# Or generate RSA key (for older servers)
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa_galeon -C "galeon@localhost"
```

### Step 2: Add Public Key to Server

You need to add the public key to your server's `authorized_keys` file.

#### Method A: Using ssh-copy-id (Easiest)

```bash
# If you can already SSH with password
ssh-copy-id -i ~/.ssh/id_ed25519_galeon.pub username@server.example.com
```

#### Method B: Manual Setup

1. Connect to your server:
   ```bash
   ssh username@server.example.com
   ```

2. Edit the authorized_keys file:
   ```bash
   nano ~/.ssh/authorized_keys
   ```

3. Paste your public key on a new line and save

4. Set correct permissions:
   ```bash
   chmod 700 ~/.ssh
   chmod 600 ~/.ssh/authorized_keys
   ```

#### Method C: Via Control Panel

Many hosting providers (AWS, DigitalOcean, Linode, etc.) allow you to add SSH keys through their web interface.

### Step 3: Connect in Galeon

1. Enter server details:
   - **Host**: `server.example.com`
   - **Port**: `22` (or your custom SSH port)
   - **Username**: Your SSH username

2. Enter the key path (or click "Use This Key" if you just generated one)

3. Click **"Connect SFTP"**

4. You should see the remote file listing!

---

## Option 2: Password Authentication

Simpler setup, but less secure than SSH keys.

### Step 1: Connect with Password

1. Open Galeon and select **SFTP / SSH**
2. Enter server details:
   - **Host**: `server.example.com`
   - **Port**: `22`
   - **Username**: Your SSH username

3. Enter your password in the **Password** field

4. Leave the SSH key path empty

5. Click **"Connect SFTP"**

### Password Storage

- **Quick Connect**: Password is held in memory only; not persisted
- **Saved Profile**: Password is stored in your OS keychain (macOS Keychain, Linux Secret Service, Windows Credential Manager)

---

## Troubleshooting

### "Connection timeout"

**Cause**: Cannot reach the server

**Solutions**:
1. Verify the hostname/IP is correct
2. Check if SSH port is correct (default: 22)
3. Ensure no firewall is blocking port 22
4. Test with terminal: `telnet server.example.com 22`

### "Authentication failed"

**Cause**: Wrong credentials or key not authorized

**Solutions**:
1. Verify username is correct (case-sensitive)
2. For password auth: Double-check password
3. For key auth:
   - Verify the public key is in `~/.ssh/authorized_keys`
   - Check permissions: `chmod 600 ~/.ssh/authorized_keys`
   - Ensure you're using the private key (not `.pub` file)
   - Try: `ssh -i ~/.ssh/id_ed25519 username@server -v`

### "Host key verification failed"

**Cause**: Server's host key not in `known_hosts`

**Solutions**:
1. Manually connect once via terminal to accept the host key:
   ```bash
   ssh username@server.example.com
   ```
2. Or clear old host keys:
   ```bash
   ssh-keygen -R server.example.com
   ```

### "Permission denied (publickey)"

**Cause**: Server doesn't accept password auth or key not recognized

**Solutions**:
1. Verify key is added to `authorized_keys`
2. Check SSH server config on the server:
   ```bash
   # /etc/ssh/sshd_config
   PubkeyAuthentication yes
   PasswordAuthentication yes  # if using password
   ```
3. Restart SSH service after config changes:
   ```bash
   sudo systemctl restart sshd
   ```

### "Connection refused"

**Cause**: SSH service not running or wrong port

**Solutions**:
1. Verify SSH is running on the server
2. Check the port number
3. Ask your hosting provider if SSH is enabled

---

## SFTP vs S3 Features Comparison

| Feature | S3 | SFTP |
|---------|-----|------|
| **Connection** | Access Key + Secret Key | SSH Key or Password |
| **Authentication** | HMAC signatures | SSH authentication |
| **Encryption** | TLS (HTTPS) | SSH tunnel (always encrypted) |
| **File Operations** | List, Upload, Download, Delete, Copy, Rename | List, Upload, Download, Delete, Rename |
| **Server-side Copy** | ✅ Yes (single API call) | ❌ No (download + re-upload) |
| **Presigned URLs** | ✅ Yes (temporary share links) | ❌ No |
| **Multipart Upload** | ✅ Yes (parallel chunked) | ❌ No (single stream) |
| **Checksum Verification** | ✅ MD5/ETag | ⚠️ Size only |
| **Storage Classes** | ✅ Multiple tiers | ❌ N/A |
| **Bucket Concept** | ✅ Yes | ❌ Flat filesystem |
| **Pause/Resume** | ✅ Yes | ✅ Yes (download only) |
| **Bandwidth Limiting** | ✅ Configurable | ✅ SSH key (OpenDAL) / ❌ Password (native)

---

## Security Tips

### For SSH Keys

1. **Use ed25519 keys** - More secure and faster than RSA
   ```bash
   ssh-keygen -t ed25519
   ```

2. **Protect your private key**
   - Keep it in `~/.ssh/` directory
   - Set correct permissions: `chmod 600 ~/.ssh/id_ed25519`
   - Never share your private key

3. **Use separate keys for different services**
   - Don't reuse the same key for GitHub, SFTP, and servers

4. **Consider passphrases**
   - For extra security, add a passphrase when generating keys
   - Note: Galeon currently doesn't support passphrase-protected keys (use key without passphrase for Galeon, or configure ssh-agent)

### For Passwords

1. **Use strong, unique passwords**
   - Minimum 12 characters
   - Mix of letters, numbers, symbols

2. **Use saved profiles** - Credentials stored in OS keychain are encrypted

3. **Don't reuse passwords** across services

### For Servers

1. **Disable password auth** when possible (use keys only)
2. **Use non-standard SSH port** to reduce automated attacks
3. **Install fail2ban** to block brute-force attempts
4. **Keep SSH server updated**

---

## Advanced: SSH Configuration

If you frequently connect to the same servers, set up `~/.ssh/config` for convenience:

```bash
# ~/.ssh/config

# Work server
Host work
    HostName server.work.com
    Port 2222
    User admin
    IdentityFile ~/.ssh/id_ed25519_work

# Personal server  
Host personal
    HostName home.example.com
    User john
    IdentityFile ~/.ssh/id_ed25519_personal

# Jump host example
Host internal
    HostName 192.168.1.100
    User admin
    ProxyJump jumphost
```

Then in Galeon, you can use:
- **Host**: `work` (uses config alias)
- Or use the full hostname

### Using ssh-agent

If your key has a passphrase, start ssh-agent and add your key:

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519
```

Galeon will use the agent for authentication.

---

## Quick Reference

| Task | Command/Action |
|------|----------------|
| **Generate key** | `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_galeon` |
| **Copy key to server** | `ssh-copy-id -i ~/.ssh/id_ed25519_galeon.pub user@host` |
| **Test connection** | `ssh -i ~/.ssh/id_ed25519 user@host` |
| **Check permissions** | `ls -la ~/.ssh/` |
| **Fix permissions** | `chmod 700 ~/.ssh && chmod 600 ~/.ssh/id_ed25519` |

---

## Getting Help

If you're still having trouble:

1. Check the server logs for connection attempts
2. Test with terminal SSH first:
   ```bash
   ssh -vvv username@server.example.com
   ```
3. Open an issue on GitHub with:
   - Error message from Galeon
   - Server OS and SSH version (if known)
   - Whether terminal SSH works

---

## Related Documentation

- [Quick start](./QUICK_START.md) — first launch and profiles
- [Roadmap](./ROADMAP.md) — protocol and product milestones
- Implementation details: `src-tauri/src/sftp_native.rs`, `src-tauri/src/lib.rs` (`StorageSession`)
