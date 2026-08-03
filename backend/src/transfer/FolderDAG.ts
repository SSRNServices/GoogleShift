import { ManifestItem } from '../utils/ManifestStorage';

export type FolderStatus = 'WAITING' | 'READY' | 'CREATING' | 'CREATED' | 'FAILED';

export interface DAGNode {
  id: string;
  name: string;
  sourceParentId: string;
  destId: string | null;
  status: FolderStatus;
  depth: number;
  children: DAGNode[];
}

export class FolderDAG {
  private nodes: Map<string, DAGNode> = new Map();
  private readyQueue: DAGNode[] = [];
  private rootDestId: string;

  constructor(rootDestId: string) {
    this.rootDestId = rootDestId;
  }

  public build(manifestFolders: ManifestItem[]) {
    // 1. Initialize all nodes
    for (const folder of manifestFolders) {
      this.nodes.set(folder.id, {
        id: folder.id,
        name: folder.name,
        sourceParentId: folder.sourceParentId,
        destId: folder.createdDestId || null,
        status: folder.status === 'SUCCESS' ? 'CREATED' : (folder.status === 'FAILED' ? 'FAILED' : 'WAITING'),
        depth: folder.depth,
        children: []
      });
    }

    // 2. Link children and evaluate READY state
    for (const node of this.nodes.values()) {
      // Root-level nodes have 'root' parent.
      if (node.sourceParentId === 'root') {
         // They inherit the ultimate root destination ID
         // But in FolderDAG, they are basically depth 0 and ready immediately.
         if (node.status === 'WAITING') {
           node.status = 'READY';
           this.readyQueue.push(node);
         }
      } else {
         const parent = this.nodes.get(node.sourceParentId);
         if (parent) {
           parent.children.push(node);
           if (parent.status === 'CREATED' && node.status === 'WAITING') {
             node.status = 'READY';
             this.readyQueue.push(node);
           }
           if (parent.status === 'FAILED' && node.status === 'WAITING') {
             node.status = 'FAILED';
             // We could cascade failure to children here, but we'll let the event bus handle it if needed.
           }
         } else {
           // Parent not in DAG (maybe not a folder?). It should theoretically never happen since the manifest is consistent, but if it does, consider it a root.
           if (node.status === 'WAITING') {
             node.status = 'READY';
             this.readyQueue.push(node);
           }
         }
      }
    }
  }

  public getNextReady(): DAGNode | null {
    if (this.readyQueue.length === 0) return null;
    const node = this.readyQueue.shift()!;
    node.status = 'CREATING';
    return node;
  }

  public getDestParentId(sourceParentId: string): string | null {
    if (sourceParentId === 'root') return this.rootDestId;
    const parent = this.nodes.get(sourceParentId);
    return parent ? parent.destId : null;
  }

  public markCreated(id: string, destId: string) {
    const node = this.nodes.get(id);
    if (!node) return;
    
    node.status = 'CREATED';
    node.destId = destId;
    
    // Unlock children
    for (const child of node.children) {
      if (child.status === 'WAITING') {
        child.status = 'READY';
        this.readyQueue.push(child);
      }
    }
  }

  public markFailed(id: string) {
    const node = this.nodes.get(id);
    if (!node) return;
    
    node.status = 'FAILED';
    // Cascading failures to children
    const cascade = (n: DAGNode) => {
       for (const child of n.children) {
          if (child.status === 'WAITING' || child.status === 'READY') {
             child.status = 'FAILED';
             cascade(child);
          }
       }
    };
    cascade(node);
  }

  public markWaiting(id: string) {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.status === 'CREATING') {
      node.status = 'READY'; // Or waiting, but it should be ready if it was creating
      this.readyQueue.push(node);
    }
  }

  public isComplete(): boolean {
    for (const node of this.nodes.values()) {
      if (node.status === 'WAITING' || node.status === 'READY' || node.status === 'CREATING') {
        return false;
      }
    }
    return true;
  }

  public resolveStuckNodes(): number {
    let resolved = 0;
    for (const node of this.nodes.values()) {
      if (node.status === 'WAITING' || node.status === 'CREATING') {
        console.warn(`[FolderDAG] Auto-failing stuck node ${node.name} (${node.id}) with status ${node.status}`);
        node.status = 'FAILED';
        resolved++;
      }
    }
    return resolved;
  }

  public getActiveCount(): number {
    let active = 0;
    for (const node of this.nodes.values()) {
      if (node.status === 'CREATING') active++;
    }
    return active;
  }

  public getReadyCount(): number {
    return this.readyQueue.length;
  }

  public getDiagnostics() {
    let rootNodes = 0;
    let leafNodes = 0;
    let edges = 0;
    
    for (const node of this.nodes.values()) {
      if (node.sourceParentId === 'root' || !this.nodes.has(node.sourceParentId)) {
        rootNodes++;
      }
      if (node.children.length === 0) {
        leafNodes++;
      }
      edges += node.children.length;
    }
    
    return {
      nodes: this.nodes.size,
      edges,
      rootNodes,
      leafNodes,
      readyQueueSize: this.readyQueue.length
    };
  }

  public dumpDAG() {
    console.error(`\n[DAG DUMP] Full DAG State:`);
    for (const node of this.nodes.values()) {
       console.error(`Node: ${node.id} | Parent: ${node.sourceParentId} | Name: ${node.name} | Status: ${node.status} | Children: ${node.children.length}`);
    }
  }
}
