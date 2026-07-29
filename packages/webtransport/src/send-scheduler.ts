/** Shared sendOrder / sendGroup scheduling for native and wasm facades. */

export type SendPolicy = {
	groupId: number;
	sendOrder: number;
};

type ScheduledTask = {
	groupId: number;
	sendOrder: number;
	seq: number;
	run: () => Promise<void>;
	resolve: () => void;
	reject: (err: unknown) => void;
};

export class SendScheduler {
	#queues = new Map<number, ScheduledTask[]>();
	#groupOrder: number[] = [];
	#rrIdx = 0;
	#running = false;
	#seq = 0;

	enqueue(policy: SendPolicy, run: () => Promise<void>): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const task: ScheduledTask = {
				groupId: policy.groupId,
				sendOrder: policy.sendOrder,
				seq: this.#seq++,
				run,
				resolve,
				reject,
			};
			const q = this.#queues.get(policy.groupId) ?? [];
			q.push(task);
			q.sort((a, b) => a.sendOrder - b.sendOrder || a.seq - b.seq);
			this.#queues.set(policy.groupId, q);
			if (!this.#groupOrder.includes(policy.groupId)) {
				this.#groupOrder.push(policy.groupId);
			}
			void this.#drain();
		});
	}

	async #drain(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			await Promise.resolve();
			while (this.#groupOrder.length > 0) {
				const groupId = this.#nextGroup();
				if (groupId == null) break;
				const q = this.#queues.get(groupId);
				if (!q || q.length === 0) {
					this.#removeGroup(groupId);
					continue;
				}
				const task = q.shift()!;
				if (q.length === 0) this.#removeGroup(groupId);
				task.run().then(task.resolve, task.reject);
			}
		} finally {
			this.#running = false;
		}
	}

	#nextGroup(): number | null {
		if (this.#groupOrder.length === 0) return null;
		if (this.#rrIdx >= this.#groupOrder.length) this.#rrIdx = 0;
		const groupId = this.#groupOrder[this.#rrIdx];
		this.#rrIdx = (this.#rrIdx + 1) % Math.max(1, this.#groupOrder.length);
		return groupId ?? null;
	}

	#removeGroup(groupId: number): void {
		this.#queues.delete(groupId);
		const idx = this.#groupOrder.indexOf(groupId);
		if (idx >= 0) this.#groupOrder.splice(idx, 1);
		if (this.#rrIdx > idx && idx >= 0) this.#rrIdx--;
		if (this.#rrIdx < 0) this.#rrIdx = 0;
	}
}
