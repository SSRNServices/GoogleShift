import { EventEmitter } from 'events';

export type MigrationEvent =
  | { type: 'ManifestLoaded'; jobId: string; totalFolders: number; totalFiles: number; totalBytes: number }
  | { type: 'FolderCreated'; jobId: string; sourceId: string; destId: string }
  | { type: 'FolderMapped'; jobId: string; sourceId: string; destId: string }
  | { type: 'FolderFailed'; jobId: string; sourceId: string; error: string }
  | { type: 'FileQueued'; jobId: string; sourceId: string }
  | { type: 'UploadStarted'; jobId: string; sourceId: string }
  | { type: 'UploadFinished'; jobId: string; sourceId: string; bytes: number }
  | { type: 'UploadFailed'; jobId: string; sourceId: string; error: string }
  | { type: 'ProgressChanged'; jobId: string; status: string; completedFolders: number; completedFiles: number; transferredBytes: number }
  | { type: 'Completed'; jobId: string };

export class MigrationEventBus extends EventEmitter {
  public emitEvent(event: MigrationEvent) {
    this.emit(event.type, event);
  }

  public onEvent<T extends MigrationEvent['type']>(
    type: T,
    listener: (event: Extract<MigrationEvent, { type: T }>) => void
  ) {
    this.on(type, listener);
  }

  public offEvent<T extends MigrationEvent['type']>(
    type: T,
    listener: (event: Extract<MigrationEvent, { type: T }>) => void
  ) {
    this.off(type, listener);
  }
}

export const eventBus = new MigrationEventBus();
