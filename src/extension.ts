import * as vscode from 'vscode';
import { deflateSync } from 'node:zlib';

const MARKER = 'PYGAME_SURFACE_PREVIEW_V1';
const CACHE_TTL_MS = 700;
const MAX_PREVIEW_PIXELS = 32_768;
const MAX_RESULT_CHARS = 60_000;

let diagnosticChannel: vscode.OutputChannel | undefined;

type PreviewPayload = {
    originalWidth: number;
    originalHeight: number;
    bitsize: number;
    width: number;
    height: number;
    rgba: Buffer;
};

type CacheEntry = {
    expiresAt: number;
    hover: vscode.Hover | undefined;
};

const previewCache = new Map<string, CacheEntry>();
const pendingEvaluations = new Map<string, Promise<vscode.Hover | undefined>>();

export function activate(context: vscode.ExtensionContext): void {
    diagnosticChannel = vscode.window.createOutputChannel('Pygame Surface Hover Preview');
    context.subscriptions.push(diagnosticChannel);

    const provider = vscode.languages.registerHoverProvider(
        { language: 'python', scheme: '*' },
        {
            provideHover: async (document, position, token) => {
                const config = vscode.workspace.getConfiguration('pygameSurfacePreview');
                if (!config.get<boolean>('enabled', true) || token.isCancellationRequested) {
                    return undefined;
                }

                const expressionInfo = extractDottedExpression(document, position);
                if (!expressionInfo) {
                    return undefined;
                }

                logDiagnostic(`Hover expression: ${expressionInfo.expression}`);
                const stackItem = vscode.debug.activeStackItem;
                if (!stackItem || !('frameId' in stackItem)) {
                    logDiagnostic('Stopped: no active stack frame is selected.');
                    return undefined;
                }

                const frame = stackItem as vscode.DebugStackFrame;
                const allowedTypes = config.get<string[]>('debuggerTypes', ['debugpy', 'python']);
                if (!allowedTypes.includes(frame.session.type)) {
                    logDiagnostic(`Stopped: unsupported debugger type "${frame.session.type}".`);
                    return undefined;
                }

                const maxDimension = clampInteger(
                    config.get<number>('maxPreviewDimension', 384), 32, 1024, 384
                );
                const maxPixels = clampInteger(
                    config.get<number>('maxPreviewPixels', MAX_PREVIEW_PIXELS),
                    1024,
                    MAX_PREVIEW_PIXELS,
                    MAX_PREVIEW_PIXELS
                );

                const cacheKey = [
                    frame.session.id,
                    frame.frameId,
                    document.uri.toString(),
                    document.version,
                    position.line,
                    expressionInfo.expression,
                    maxDimension,
                    maxPixels
                ].join('|');

                const cached = previewCache.get(cacheKey);
                if (cached && cached.expiresAt > Date.now()) {
                    logDiagnostic(`Cache hit: ${cached.hover ? 'preview available' : 'previous evaluation returned no preview'}.`);
                    return cached.hover;
                }

                const existing = pendingEvaluations.get(cacheKey);
                if (existing) {
                    logDiagnostic('Waiting for an evaluation already in progress.');
                    return existing;
                }

                logDiagnostic(`Evaluating in debugger "${frame.session.type}", frame ${frame.frameId}.`);
                const task = createPreviewHover(
                    frame,
                    expressionInfo.expression,
                    expressionInfo.range,
                    maxDimension,
                    maxPixels
                ).then((hover) => {
                    previewCache.set(cacheKey, {
                        expiresAt: Date.now() + CACHE_TTL_MS,
                        hover
                    });
                    trimCache();
                    logDiagnostic(hover ? 'Preview hover created.' : 'Evaluation completed without a preview.');
                    return hover;
                }).catch((error: unknown) => {
                    logDiagnostic(`Evaluation failed: ${errorMessage(error)}`);
                    return undefined;
                }).finally(() => {
                    pendingEvaluations.delete(cacheKey);
                });

                pendingEvaluations.set(cacheKey, task);
                return task;
            }
        }
    );

    context.subscriptions.push(provider);
    context.subscriptions.push(vscode.debug.onDidChangeActiveStackItem(() => {
        previewCache.clear();
    }));
    context.subscriptions.push(vscode.debug.onDidChangeActiveDebugSession(() => {
        previewCache.clear();
    }));
}

export function deactivate(): void {
    previewCache.clear();
    pendingEvaluations.clear();
    diagnosticChannel = undefined;
}

function logDiagnostic(message: string): void {
    diagnosticChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Extracts a deliberately small Python expression grammar:
 *   name
 *   object.attribute
 *   object.attribute.more
 *
 * Calls, indexes, operators, and arbitrary expressions are intentionally excluded.
 */
function extractDottedExpression(
    document: vscode.TextDocument,
    position: vscode.Position
): { expression: string; range: vscode.Range } | undefined {
    if (position.line < 0 || position.line >= document.lineCount) {
        return undefined;
    }

    const line = document.lineAt(position.line).text;
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!wordRange) {
        return undefined;
    }

    const pattern = /[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (position.character >= start && position.character <= end) {
            const expressionEnd = Math.min(wordRange.end.character, end);
            const expression = line.slice(start, expressionEnd).replace(/\s+/g, '');
            if (!expression || expression.length > 160) {
                return undefined;
            }

            // Only return the dotted expression if the cursor is on an identifier,
            // not merely on a dot or whitespace.
            const cursorOffset = position.character;
            const charAtCursor = line[cursorOffset] ?? '';
            const charBeforeCursor = line[cursorOffset - 1] ?? '';
            if (!/[A-Za-z0-9_]/.test(charAtCursor) && !/[A-Za-z0-9_]/.test(charBeforeCursor)) {
                return undefined;
            }

            return {
                expression,
                range: new vscode.Range(
                    new vscode.Position(position.line, start),
                    new vscode.Position(position.line, expressionEnd)
                )
            };
        }
    }

    return {
        expression: document.getText(wordRange),
        range: wordRange
    };
}

async function createPreviewHover(
    frame: vscode.DebugStackFrame,
    expression: string,
    range: vscode.Range,
    maxDimension: number,
    maxPixels: number
): Promise<vscode.Hover | undefined> {
    let requestMaxPixels = maxPixels;
    let payload: PreviewPayload | undefined;

    while (!payload) {
        const pythonExpression = buildPythonExpression(
            expression,
            maxDimension,
            requestMaxPixels
        );

        // The expression consists only of a name and optional dotted attributes.
        // context='repl' is required because generating the pixel data calls pygame APIs.
        // This runs in the paused debuggee, just like evaluating an expression in Debug Console.
        const response = await frame.session.customRequest('evaluate', {
            expression: pythonExpression,
            frameId: frame.frameId,
            context: 'repl'
        });

        const rawResult = typeof response?.result === 'string' ? response.result : '';
        logDiagnostic(`Debugger response: resultType=${typeof response?.result}, resultLength=${rawResult.length}.`);
        if (rawResult.length >= MAX_RESULT_CHARS) {
            const smallerMaxPixels = Math.floor(requestMaxPixels / 2);
            if (smallerMaxPixels < 1024) {
                logDiagnostic(`Stopped: debugger response still reaches ${MAX_RESULT_CHARS} characters at the minimum preview size.`);
                return undefined;
            }
            logDiagnostic(`Debugger response is too large; retrying with at most ${smallerMaxPixels} pixels.`);
            requestMaxPixels = smallerMaxPixels;
            continue;
        }

        const result = unwrapDebugString(rawResult);
        if (!result.startsWith(`${MARKER}|`)) {
            logDiagnostic('Stopped: debugger result does not contain the expected preview marker.');
            return undefined;
        }

        payload = parsePayload(result);
        if (!payload) {
            logDiagnostic('Stopped: debugger preview payload failed validation.');
            return undefined;
        }
    }

    const png = encodePng(payload.width, payload.height, payload.rgba);
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${escapeMarkdown(expression)}** · **pygame.Surface**\n\n`);
    markdown.appendMarkdown(`![Surface preview](data:image/png;base64,${png.toString('base64')})\n\n`);
    markdown.appendMarkdown(
        `**Size:** ${payload.originalWidth} × ${payload.originalHeight} px  \n` +
        `**Bitsize:** ${payload.bitsize}  \n` +
        `**Preview:** ${payload.width} × ${payload.height} px`
    );
    markdown.isTrusted = false;
    markdown.supportHtml = false;

    logDiagnostic(`Preview image encoded: ${payload.width}x${payload.height}, ${png.length} PNG bytes.`);
    return new vscode.Hover(markdown, range);
}

function buildPythonExpression(
    expression: string,
    maxDimension: number,
    maxPixels: number
): string {
    // No user-provided arbitrary code is accepted here: expression has already been
    // restricted to identifiers and dotted attributes by extractDottedExpression().
    return `(
        lambda _s: (
            (lambda _w, _h: (
                lambda _scale: (
                    lambda _p: '${MARKER}|' + str(_w) + '|' + str(_h) + '|' +
                    str(_s.get_bitsize()) + '|' + str(_p.get_width()) + '|' +
                    str(_p.get_height()) + '|' +
                    __import__('base64').b64encode(
                        __import__('pygame').image.tobytes(_p, 'RGBA', False)
                    ).decode('ascii')
                )(
                    __import__('pygame').transform.smoothscale(
                        _s,
                        (max(1, int(_w * _scale)), max(1, int(_h * _scale)))
                    ) if _scale < 1.0 else _s
                )
            )(
                min(
                    1.0,
                    ${maxDimension} / float(max(1, _w, _h)),
                    (${maxPixels} / float(max(1, _w * _h))) ** 0.5
                )
            )
            )(_s.get_width(), _s.get_height())
            if isinstance(_s, __import__('pygame').Surface) else ''
        )
    )(${expression})`;
}


function unwrapDebugString(value: string): string {
    // Many debug adapters format Python strings using repr(), surrounding the
    // result with quotes. Our payload is restricted to ASCII marker/number/Base64
    // characters, so removing those outer quotes is sufficient.
    if (value.length >= 2) {
        const quote = value[0];
        if ((quote === "'" || quote === '"') && value[value.length - 1] === quote) {
            return value.slice(1, -1);
        }
    }
    return value;
}

function parsePayload(result: string): PreviewPayload | undefined {
    const parts = result.split('|');
    if (parts.length !== 7 || parts[0] !== MARKER) {
        return undefined;
    }

    const [originalWidth, originalHeight, bitsize, width, height] = parts.slice(1, 6).map(Number);
    const base64 = parts[6];
    const integers = [originalWidth, originalHeight, bitsize, width, height];
    if (!integers.every((value) => Number.isSafeInteger(value) && value >= 0)) {
        return undefined;
    }
    if (width < 1 || height < 1 || width * height > MAX_PREVIEW_PIXELS) {
        return undefined;
    }

    const rgba = Buffer.from(base64, 'base64');
    if (rgba.length !== width * height * 4) {
        return undefined;
    }

    return { originalWidth, originalHeight, bitsize, width, height, rgba };
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
    const rowBytes = width * 4;
    const scanlines = Buffer.alloc((rowBytes + 1) * height);

    for (let y = 0; y < height; y += 1) {
        const targetOffset = y * (rowBytes + 1);
        scanlines[targetOffset] = 0; // PNG filter type: None
        rgba.copy(scanlines, targetOffset + 1, y * rowBytes, (y + 1) * rowBytes);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type: RGBA
    ihdr[10] = 0; // compression method
    ihdr[11] = 0; // filter method
    ihdr[12] = 0; // no interlace

    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(scanlines)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);

    const crcInput = Buffer.concat([typeBuffer, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function escapeMarkdown(value: string): string {
    return value.replace(/[\\`*_{}\[\]()#+\-.!|]/g, '\\$&');
}

function trimCache(): void {
    if (previewCache.size <= 128) {
        return;
    }
    const now = Date.now();
    for (const [key, entry] of previewCache) {
        if (entry.expiresAt <= now || previewCache.size > 96) {
            previewCache.delete(key);
        }
    }
}
