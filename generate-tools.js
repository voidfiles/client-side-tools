#!/usr/bin/env node

/**
 * Automatically generates tools.json by scanning the tools/ directory
 *
 * Usage: node generate-tools.js
 *
 * Each tool folder should contain:
 * - index.html (required)
 * - tool.json (optional) with metadata: { "name": "...", "description": "..." }
 *
 * If tool.json doesn't exist, the tool name is derived from the folder name
 */

const fs = require('fs');
const path = require('path');

const TOOLS_DIR = path.join(__dirname, 'tools');
const OUTPUT_FILE = path.join(__dirname, 'tools.json');

function kebabToTitle(kebab) {
    return kebab
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function scanTools() {
    if (!fs.existsSync(TOOLS_DIR)) {
        console.error('Error: tools/ directory not found');
        process.exit(1);
    }

    const tools = [];
    const entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const toolId = entry.name;
        const toolPath = path.join(TOOLS_DIR, toolId);
        const indexPath = path.join(toolPath, 'index.html');

        // Skip if no index.html exists
        if (!fs.existsSync(indexPath)) {
            console.warn(`Warning: Skipping ${toolId} - no index.html found`);
            continue;
        }

        // Check for optional tool.json metadata
        const metadataPath = path.join(toolPath, 'tool.json');
        let metadata = {};

        if (fs.existsSync(metadataPath)) {
            try {
                const content = fs.readFileSync(metadataPath, 'utf8');
                metadata = JSON.parse(content);
            } catch (error) {
                console.warn(`Warning: Failed to parse ${toolId}/tool.json - using defaults`);
            }
        }

        // Create tool entry
        const tool = {
            id: toolId,
            name: metadata.name || kebabToTitle(toolId),
            description: metadata.description || `A client-side ${kebabToTitle(toolId).toLowerCase()} tool`
        };

        tools.push(tool);
        console.log(`✓ Found: ${tool.name}`);
    }

    return tools;
}

function main() {
    console.log('Scanning tools directory...\n');

    const tools = scanTools();

    // Sort tools alphabetically by name
    tools.sort((a, b) => a.name.localeCompare(b.name));

    // Write to tools.json
    const json = JSON.stringify(tools, null, 2);
    fs.writeFileSync(OUTPUT_FILE, json + '\n');

    console.log(`\n✓ Generated tools.json with ${tools.length} tool(s)`);
}

if (require.main === module) {
    main();
}

module.exports = { scanTools, kebabToTitle };
