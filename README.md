# EV Queue Manager

A simple WhatsApp group queue manager bot. Allows users to join and leave a queue, and view the current state of the queue.

- Uses [Baileys](https://github.com/WhiskeySockets/Baileys) to connect to WhatsApp
- Listens for incoming messages and processes supported commands
- Maintains an in-memory queue
- Automatically resets the queue every day at 6am Dublin Time

## Prerequisites

- Node.js
- npm

## Installation

```bash
git clone https://github.com/jaaufauvre/ev-queue-manager.git
cd ev-queue-manager
npm install
```

## Usage

```bash
npm run start
```

- On first launch, the program will display a QR code in the terminal. Scan this code with a WhatsApp instance using the bot account.
- Session credentials are stored in the `auth_info/` directory. To protect sensitive data, the directory is added to the `.gitignore`.
- After connecting, invite the bot to a WhatsApp group
- Use the following commands in the WhatsApp group chat:

Available commands:
* `/help` – View the command menu
* `/join` – Enter the queue
* `/leave` – Exit the queue
* `/queue` – Display the queue

## Development

- Build:
```bash
npm run build
```
- Lint code:
```bash
npm run lint
```
- Format code:
```bash
npm run format
```
