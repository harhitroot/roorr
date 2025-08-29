# Overview

This project is a Telegram bot wrapper that integrates with an existing Node.js Telegram media script. The bot provides a conversational interface to replicate the complete CLI workflow of the original script, including phone number authentication, OTP verification, channel selection, and media download/upload operations. The architecture follows a strict "zero code modification" approach, using the original repository exactly as-is via git clone and creating a minimal wrapper to pipe bot messages to the CLI script's stdin while forwarding stdout back to users.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Bot Framework Architecture
The system uses the Telegraf framework for Telegram bot development, providing a robust foundation for handling bot interactions and message processing. The bot operates as a stateful wrapper that maintains user sessions and conversation context throughout the authentication and operation workflow.

## Process Communication Design
The core architectural decision involves using Node.js child processes to interact with the cloned repository script. The bot spawns the original CLI script as a child process and establishes bidirectional communication through stdin/stdout piping. This approach preserves the original script's functionality while providing a bot interface.

## State Management System
The bot implements a comprehensive state machine with defined states including IDLE, AWAITING_CONSENT, AWAITING_PHONE, AWAITING_OTP, AWAITING_CHANNEL, AWAITING_OPTION, AWAITING_DESTINATION, and PROCESSING. User sessions are stored in memory using a Map data structure, allowing the bot to handle multiple concurrent users while maintaining individual conversation contexts.

## Security and Consent Framework
The architecture includes explicit security measures requiring user consent before login processes. The bot warns users about Telegram account access and requires explicit "I consent" confirmation before proceeding with authentication workflows.

## Repository Integration Strategy
The system clones the target repository on startup and manages it as an external dependency. The bot removes existing directories and performs fresh clones to ensure clean state management. This approach allows the wrapper to use any compatible Node.js Telegram media script without code modifications.

## Error Handling and Communication
The architecture forwards all CLI script errors directly to bot users without modification, preserving the original script's error reporting while providing real-time feedback through the Telegram interface.

# External Dependencies

## Telegram Bot API
The system integrates with Telegram's Bot API through the Telegraf framework (version 4.16.3), providing the primary interface for user interactions and message handling.

## GitHub Repository Integration
The bot clones and integrates with an external GitHub repository (https://github.com/adamfarreledu-cloud/java.git) containing the original Node.js Telegram media script. This repository is treated as a black box and used without modifications.

## Node.js Child Process System
The architecture relies on Node.js's built-in child_process module for spawning and communicating with the cloned script, enabling seamless integration between the bot interface and CLI functionality.

## File System Operations
The system uses Node.js fs and path modules for repository management, including directory cleanup and file system operations required for the git clone workflow.

## Environment Configuration
The bot expects BOT_TOKEN to be provided through environment variables, following standard security practices for API token management.