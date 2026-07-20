export class RequestValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RequestValidationError';
    }
}

export class ManifestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ManifestError';
    }
}

export class ShortcutResolutionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ShortcutResolutionError';
    }
}

export class GoogleDriveError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GoogleDriveError';
    }
}
