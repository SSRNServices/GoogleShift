export function safeSerialize(obj: any): string {
    if (typeof obj === 'string') {
        return obj;
    }
    return JSON.stringify(obj);
}

export function safeDeserialize<T>(value: any): T {
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            return value as any;
        }
    }
    return value as T;
}
