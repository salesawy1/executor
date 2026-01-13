/**
 * Color-coded section logger for executor
 * Makes logs easy to read by grouping related steps into colored sections
 */

// ANSI color codes for terminal output
const colors = {
    // Section colors (background + text)
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',

    // Foreground colors
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',

    // Bright foreground colors
    brightRed: '\x1b[91m',
    brightGreen: '\x1b[92m',
    brightYellow: '\x1b[93m',
    brightBlue: '\x1b[94m',
    brightMagenta: '\x1b[95m',
    brightCyan: '\x1b[96m',
    brightWhite: '\x1b[97m',

    // Background colors
    bgBlack: '\x1b[40m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
    bgWhite: '\x1b[47m',

    // Bright backgrounds
    bgBrightBlack: '\x1b[100m',
    bgBrightRed: '\x1b[101m',
    bgBrightGreen: '\x1b[102m',
    bgBrightYellow: '\x1b[103m',
    bgBrightBlue: '\x1b[104m',
    bgBrightMagenta: '\x1b[105m',
    bgBrightCyan: '\x1b[106m',
    bgBrightWhite: '\x1b[107m',
};

// Section types with their associated colors and icons
export type SectionType =
    | 'connection'
    | 'position_check'
    | 'order_form'
    | 'direction'
    | 'order_type'
    | 'quantity'
    | 'take_profit'
    | 'stop_loss'
    | 'place_order'
    | 'confirmation'
    | 'result'
    | 'error'
    | 'debug';

interface SectionConfig {
    icon: string;
    label: string;
    color: string;
    headerBg: string;
}

const sectionConfigs: Record<SectionType, SectionConfig> = {
    connection: {
        icon: '🔗',
        label: 'CONNECTION',
        color: colors.cyan,
        headerBg: colors.bgCyan + colors.black,
    },
    position_check: {
        icon: '📋',
        label: 'POSITION CHECK',
        color: colors.yellow,
        headerBg: colors.bgYellow + colors.black,
    },
    order_form: {
        icon: '📝',
        label: 'ORDER FORM',
        color: colors.blue,
        headerBg: colors.bgBlue + colors.white,
    },
    direction: {
        icon: '⬆️',
        label: 'DIRECTION',
        color: colors.brightMagenta,
        headerBg: colors.bgMagenta + colors.white,
    },
    order_type: {
        icon: '📊',
        label: 'ORDER TYPE',
        color: colors.brightBlue,
        headerBg: colors.bgBrightBlue + colors.black,
    },
    quantity: {
        icon: '🔢',
        label: 'QUANTITY',
        color: colors.brightCyan,
        headerBg: colors.bgBrightCyan + colors.black,
    },
    take_profit: {
        icon: '🎯',
        label: 'TAKE PROFIT',
        color: colors.brightGreen,
        headerBg: colors.bgGreen + colors.white,
    },
    stop_loss: {
        icon: '🛑',
        label: 'STOP LOSS',
        color: colors.brightRed,
        headerBg: colors.bgRed + colors.white,
    },
    place_order: {
        icon: '🚀',
        label: 'PLACE ORDER',
        color: colors.brightYellow,
        headerBg: colors.bgBrightYellow + colors.black,
    },
    confirmation: {
        icon: '✅',
        label: 'CONFIRMATION',
        color: colors.green,
        headerBg: colors.bgGreen + colors.white,
    },
    result: {
        icon: '📈',
        label: 'RESULT',
        color: colors.brightWhite,
        headerBg: colors.bgWhite + colors.black,
    },
    error: {
        icon: '❌',
        label: 'ERROR',
        color: colors.brightRed,
        headerBg: colors.bgBrightRed + colors.white,
    },
    debug: {
        icon: '🔍',
        label: 'DEBUG',
        color: colors.dim + colors.white,
        headerBg: colors.bgBrightBlack + colors.white,
    },
};

export class SectionLogger {
    private logs: string[] = [];
    private startTime: number;
    private currentSection: SectionType | null = null;
    private sectionStartTime: number = 0;

    constructor() {
        this.startTime = Date.now();
    }

    /**
     * Start a new colored section with a header
     */
    startSection(type: SectionType, subtitle?: string): void {
        const config = sectionConfigs[type];
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);

        // End previous section if one was active
        if (this.currentSection) {
            this.endSection();
        }

        this.currentSection = type;
        this.sectionStartTime = Date.now();

        // Print section header
        const headerWidth = 60;
        const headerText = ` ${config.icon} ${config.label} ${subtitle ? `- ${subtitle}` : ''} `;
        const padding = Math.max(0, headerWidth - headerText.length);
        const leftPad = Math.floor(padding / 2);
        const rightPad = padding - leftPad;

        const header = `${config.headerBg}${' '.repeat(leftPad)}${headerText}${' '.repeat(rightPad)}${colors.reset}`;

        console.log('');
        console.log(header);
        console.log(`${config.color}${'─'.repeat(headerWidth)}${colors.reset}`);

        this.logs.push('');
        this.logs.push(`[${new Date().toISOString()}] [+${elapsed}s] ═══ ${config.label} ${subtitle || ''} ═══`);
    }

    /**
     * End the current section with a subtle footer
     */
    endSection(): void {
        if (!this.currentSection) return;

        const config = sectionConfigs[this.currentSection];
        const sectionDuration = ((Date.now() - this.sectionStartTime) / 1000).toFixed(2);

        console.log(`${config.color}${'─'.repeat(40)} (${sectionDuration}s)${colors.reset}`);
        this.logs.push(`[Section completed in ${sectionDuration}s]`);

        this.currentSection = null;
    }

    /**
     * Log a message within the current section
     */
    log(msg: string): void {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
        const timestamp = new Date().toISOString();

        // Get current section color
        const color = this.currentSection
            ? sectionConfigs[this.currentSection].color
            : colors.white;

        // Format based on message type
        let formattedMsg = msg;

        // DOM details - make them dimmer
        if (msg.includes('[DOM]')) {
            formattedMsg = `${colors.dim}${msg}${colors.reset}`;
        }
        // Checkmarks - highlight them
        else if (msg.includes('✓') || msg.includes('✅')) {
            formattedMsg = `${colors.brightGreen}${msg}${colors.reset}`;
        }
        // Warnings
        else if (msg.includes('⚠️') || msg.includes('WARNING')) {
            formattedMsg = `${colors.brightYellow}${msg}${colors.reset}`;
        }
        // Errors
        else if (msg.includes('❌') || msg.includes('ERROR') || msg.includes('FAILED')) {
            formattedMsg = `${colors.brightRed}${msg}${colors.reset}`;
        }
        // Regular messages - use section color
        else {
            formattedMsg = `${color}${msg}${colors.reset}`;
        }

        console.log(`  ${formattedMsg}`);
        this.logs.push(`[${timestamp}] [+${elapsed}s] ${msg}`);
    }

    /**
     * Log a sub-item (indented further)
     */
    detail(msg: string): void {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
        const timestamp = new Date().toISOString();

        const color = this.currentSection
            ? sectionConfigs[this.currentSection].color
            : colors.white;

        console.log(`  ${colors.dim}│${colors.reset} ${color}${msg}${colors.reset}`);
        this.logs.push(`[${timestamp}] [+${elapsed}s]    ${msg}`);
    }

    /**
     * Log DOM interaction detail (very dim)
     */
    dom(msg: string): void {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
        const timestamp = new Date().toISOString();

        console.log(`  ${colors.dim}│ [DOM] ${msg}${colors.reset}`);
        this.logs.push(`[${timestamp}] [+${elapsed}s]    [DOM] ${msg}`);
    }

    /**
     * Log a success message
     */
    success(msg: string): void {
        console.log(`  ${colors.brightGreen}✓ ${msg}${colors.reset}`);
        this.logs.push(`✓ ${msg}`);
    }

    /**
     * Log an error message
     */
    error(msg: string): void {
        console.log(`  ${colors.brightRed}✗ ${msg}${colors.reset}`);
        this.logs.push(`✗ ${msg}`);
    }

    /**
     * Log a warning message
     */
    warn(msg: string): void {
        console.log(`  ${colors.brightYellow}⚠ ${msg}${colors.reset}`);
        this.logs.push(`⚠ ${msg}`);
    }

    /**
     * Print a major header (for order start/end)
     */
    header(title: string, type: 'start' | 'end' | 'error' = 'start'): void {
        const width = 60;
        let bg: string;
        let fg: string;
        let icon: string;

        switch (type) {
            case 'start':
                bg = colors.bgBlue;
                fg = colors.brightWhite + colors.bold;
                icon = '📤';
                break;
            case 'end':
                bg = colors.bgGreen;
                fg = colors.white + colors.bold;
                icon = '✅';
                break;
            case 'error':
                bg = colors.bgRed;
                fg = colors.white + colors.bold;
                icon = '❌';
                break;
        }

        const titleText = ` ${icon} ${title} `;
        const padding = Math.max(0, width - titleText.length);
        const leftPad = Math.floor(padding / 2);
        const rightPad = padding - leftPad;

        console.log('');
        console.log(`${bg}${fg}${'═'.repeat(width)}${colors.reset}`);
        console.log(`${bg}${fg}${' '.repeat(leftPad)}${titleText}${' '.repeat(rightPad)}${colors.reset}`);
        console.log(`${bg}${fg}${'═'.repeat(width)}${colors.reset}`);

        this.logs.push('');
        this.logs.push(`${'═'.repeat(width)}`);
        this.logs.push(`${icon} ${title}`);
        this.logs.push(`${'═'.repeat(width)}`);
    }

    /**
     * Get all captured logs for return in ExecutionResult
     */
    getLogs(): string[] {
        return [...this.logs];
    }

    /**
     * Get elapsed time since logger creation
     */
    getElapsedSeconds(): number {
        return (Date.now() - this.startTime) / 1000;
    }
}

// Export a factory function for convenience
export function createSectionLogger(): SectionLogger {
    return new SectionLogger();
}
