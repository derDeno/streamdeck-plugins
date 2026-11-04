import { moveDesk, MOVE_REFRESH_MS, setHeight, recallPreset } from "./board.js";

type Hold = { owner: string; timer?: ReturnType<typeof setTimeout> };

// One command lane per board keeps a release/stop behind an in-flight movement request.
export class Motion {
  private readonly holds = new Map<string, Hold>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();

  get isHolding(): boolean { return this.holds.size > 0; }

  private enqueue(board: string, command: () => Promise<void>): Promise<void> {
    const result = (this.lanes.get(board) ?? Promise.resolve()).then(command);
    const settled = result.catch(() => {}).finally(() => {
      if (this.lanes.get(board) === settled) this.lanes.delete(board);
    });
    this.lanes.set(board, settled);
    return result;
  }

  stop(board: string): Promise<void> {
    const hold = this.holds.get(board);
    clearTimeout(hold?.timer);
    this.holds.delete(board);
    this.generations.set(board, (this.generations.get(board) ?? 0) + 1);
    return this.enqueue(board, () => moveDesk(board, "stop"));
  }

  release(owner: string): Promise<void> {
    return Promise.all([...this.holds].filter(([, hold]) => hold.owner === owner)
      .map(([board]) => this.stop(board))).then(() => {});
  }

  stopAll(): Promise<void> {
    return Promise.all([...this.holds.keys()].map((board) => this.stop(board))).then(() => {});
  }

  start(board: string, owner: string, direction: "up" | "down", onError: (error: unknown) => void): void {
    if (this.holds.has(board)) void this.stop(board).catch(onError);
    const hold: Hold = { owner };
    this.holds.set(board, hold);
    const tick = async (): Promise<void> => {
      try {
        await this.enqueue(board, async () => {
          if (this.holds.get(board) === hold) await moveDesk(board, direction);
        });
        if (this.holds.get(board) === hold) hold.timer = setTimeout(() => void tick(), MOVE_REFRESH_MS);
      } catch (error) {
        if (this.holds.get(board) === hold) {
          await this.stop(board).catch(() => {});
          onError(error);
        }
      }
    };
    void tick();
  }

  height(board: string, height: number): Promise<void> {
    return this.position(board, (current) => setHeight(board, height, current));
  }

  preset(board: string, slot: number, currentBoard: () => boolean): Promise<void> {
    return this.position(board, (current) => recallPreset(board, slot, () => current() && currentBoard()));
  }

  private position(board: string, command: (current: () => boolean) => Promise<void>): Promise<void> {
    if (this.holds.has(board)) {
      // Do not start a target movement if the preceding stop could not be delivered.
      const stopped = this.stop(board);
      const generation = this.generations.get(board);
      return this.enqueue(board, async () => {
        await stopped;
        if (this.generations.get(board) === generation) await command(() => this.generations.get(board) === generation);
      });
    }
    const generation = this.generations.get(board);
    return this.enqueue(board, async () => {
      if (this.generations.get(board) === generation) await command(() => this.generations.get(board) === generation);
    });
  }
}
