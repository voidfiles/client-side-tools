# Client-Side Tools

A collection of useful browser-based utilities that run entirely in your browser. No data is sent to any server.

## Structure

```
client-side-tools/
├── index.html           # Main page that lists all tools
├── tools.json          # Manifest of all available tools
├── generate-tools.js   # Script to auto-generate tools.json
└── tools/              # Directory containing individual tools
    ├── color-picker/
    │   └── index.html
    └── json-formatter/
        └── index.html
```

## Available Tools

- **Color Picker** - Pick and convert colors between HEX, RGB, and HSL formats
- **JSON Formatter** - Format, validate, and beautify JSON data

## Adding a New Tool

1. Create a new directory in the `tools/` folder with a descriptive name (use kebab-case)
2. Create an `index.html` file in that directory with your tool
3. Add an entry to `tools.json` with the tool information:

```json
{
  "id": "your-tool-name",
  "name": "Your Tool Display Name",
  "description": "Brief description of what your tool does"
}
```

Or use the auto-generation script:

```bash
node generate-tools.js
```

This will automatically scan the `tools/` directory and update `tools.json` based on the tools it finds.

## Tool Template

Each tool should be a standalone HTML file with inline CSS and JavaScript. Here's a minimal template:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your Tool Name - Client-Side Tools</title>
    <style>
        /* Your styles here */
    </style>
</head>
<body>
    <div class="container">
        <a href="../../" class="back-link">← Back to Tools</a>

        <header>
            <h1>Your Tool Name</h1>
            <p>Tool description</p>
        </header>

        <!-- Your tool content here -->
    </div>

    <script>
        // Your JavaScript here
    </script>
</body>
</html>
```

## Development

Simply open `index.html` in your browser to see the tools list. Each tool runs independently with no build process required.

## Features

- 🚀 No build process needed
- 🔒 All processing happens client-side
- 📱 Responsive design
- ✨ Easy to add new tools
- 🎨 Consistent styling across tools

## License

MIT
