# Telegram Media Bot Wrapper

A Telegram bot that integrates with an existing Node.js Telegram media script, providing CLI functionality through a bot chat interface.

## Features

- **Zero Code Modification**: Uses the original repository exactly as-is via git clone
- **Complete CLI Workflow**: Replicates phone number → OTP → channel selection → download/upload options
- **Full Feature Preservation**: Supports parallel downloading, captions, restricted messages, all media types
- **Real-time Communication**: Pipes user messages to CLI script's stdin and forwards stdout back to user
- **Security First**: Warnings and explicit consent before login process
- **State Management**: Handles ongoing conversations and script interactions
- **Error Forwarding**: Passes CLI script errors to bot user without modification

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   