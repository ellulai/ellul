## CRITICAL SECURITY - DO NOT MODIFY
**NEVER modify these files:**
- /etc/ellul/shield-data/.web_locked_activated - Security tier marker
- /etc/ellul/security-tier - Security tier state
- /etc/ellul/domain - Server domain configuration
- /etc/ellul/server_id - Server identity
- __HOME_DIR__/.ssh/authorized_keys - SSH authentication
- /var/lib/sovereign-shield/ - Authentication database and state

**NEVER run commands that:**
- Delete or modify files in /etc/ellul/
- Stop or disable sovereign-shield, sshd, or core services
- Modify systemd service files for security services

Tampering with security files can permanently lock out the user with NO recovery path.