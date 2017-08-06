import { PromisePoolGroup, PromisePoolGroupConfig } from "../public/group";
import { PromisePoolExecutor } from "../public/pool";
import { GenericTaskParams, GenericTaskParamsConverted, PromisePoolTask, TaskState } from "../public/task";
import { PromisePoolGroupPrivate } from "./group";
import { debug, isNull, ResolvablePromise, TaskError } from "./utils";

const GLOBAL_GROUP_INDEX = 0;

export interface GenericTaskParamsInternal<R> {
    pool: PromisePoolExecutor;
    globalGroup: PromisePoolGroupPrivate;
    triggerNextCallback: () => void;
    triggerNowCallback: () => void;
    detach: () => void;
}

export class PromisePoolTaskPrivate<R> implements PromisePoolTask<any> {
    private _groups: PromisePoolGroupPrivate[];
    private _generator: (invocation: number) => Promise<R> | null;
    private _taskGroup: PromisePoolGroupPrivate;
    private _invocations: number = 0;
    private _invocationLimit: number = Infinity;
    private _result: R[] = [];
    private _returnResult: any;
    private _state: TaskState;
    private _rejection?: TaskError;
    private _init: boolean;
    private _promises: Array<ResolvablePromise<any>> = [];
    private _pool: PromisePoolExecutor;
    private _triggerCallback: () => void;
    private _detachCallback: (groups: PromisePoolGroupPrivate[]) => void;
    private _resultConverter?: (result: R[]) => any;

    public constructor(
        internalPrams: GenericTaskParamsInternal<R>,
        params: GenericTaskParams<R> | GenericTaskParamsConverted<any, R>,
    ) {
        debug("Creating task");
        this._pool = internalPrams.pool;
        this._triggerCallback = internalPrams.triggerNowCallback;
        this._detachCallback = internalPrams.detach;
        this._resultConverter = (params as GenericTaskParamsConverted<any, R>).resultConverter;
        this._state = params.paused ? TaskState.Paused : TaskState.Active;

        if (!isNull(params.invocationLimit)) {
            if (typeof params.invocationLimit !== "number") {
                throw new Error("Invalid invocation limit: " + params.invocationLimit);
            }
            this._invocationLimit = params.invocationLimit;
        }
        // Create a group exclusively for this task. This may throw errors.
        this._taskGroup = new PromisePoolGroupPrivate(internalPrams.pool, internalPrams.triggerNextCallback, params);
        this._groups = [internalPrams.globalGroup, this._taskGroup];
        if (params.groups) {
            const groups = params.groups as PromisePoolGroupPrivate[];
            groups.forEach((group) => {
                if (group._pool !== this._pool) {
                    throw new Error("params.groups contains a group belonging to a different pool");
                }
            });
            this._groups.push(...groups);
        }
        this._generator = params.generator;

        // Resolve the promise only after all parameters have been validated
        if (params.invocationLimit <= 0) {
            this.end();
            return;
        }

        this._groups.forEach((group) => {
            group._incrementTasks();
        });

        // The creator will trigger the promises to run
    }

    public get activePromiseCount(): number {
        return this._taskGroup._activePromiseCount;
    }

    public get invocations(): number {
        return this._invocations;
    }

    public get invocationLimit(): number {
        return this._invocationLimit;
    }

    public set invocationLimit(val: number) {
        if (isNull(val)) {
            this._invocationLimit = Infinity;
        } else if (!isNaN(val) && typeof val === "number" && val >= 0) {
            this._invocationLimit = val;
            if (this._invocations >= this._invocationLimit) {
                this.end();
            }
        } else {
            throw new Error("Invalid invocation limit: " + val);
        }
        if (this._triggerCallback) {
            this._triggerCallback();
        }
    }

    public get concurrencyLimit(): number {
        return this._taskGroup.concurrencyLimit;
    }

    public set concurrencyLimit(val: number) {
        this._taskGroup.concurrencyLimit = val;
    }

    public get frequencyLimit(): number {
        return this._taskGroup.frequencyLimit;
    }

    public set frequencyLimit(val: number) {
        this._taskGroup.frequencyLimit = val;
    }

    public get frequencyWindow(): number {
        return this._taskGroup.frequencyWindow;
    }

    public set frequencyWindow(val: number) {
        this._taskGroup.frequencyWindow = val;
    }

    public get freeSlots(): number {
        let freeSlots: number = this._invocationLimit - this._invocations;
        this._groups.forEach((group) => {
            const slots = group.freeSlots;
            if (slots < freeSlots) {
                freeSlots = slots;
            }
        });
        return freeSlots;
    }

    public get state(): TaskState {
        return this._state;
    }

    /**
     * Returns a promise which resolves when the task completes.
     */
    public promise(): Promise<any> {
        if (this._rejection) {
            this._rejection.handled = true;
            return Promise.reject(this._rejection.error);
        } else if (this._state === TaskState.Terminated) {
            return Promise.resolve(this._returnResult);
        }

        const promise: ResolvablePromise<any> = new ResolvablePromise();
        this._promises.push(promise);
        return promise.promise;
    }

    /**
     * Pauses a running task, preventing any additional promises from being generated.
     */
    public pause(): void {
        if (this._state === TaskState.Active) {
            this._state = TaskState.Paused;
        }
    }

    /**
     * Pauses resumed a paused task, allowing for the generation of additional promises.
     */
    public resume(): void {
        if (this._state === TaskState.Paused) {
            this._state = TaskState.Active;
            this._triggerCallback();
        }
    }

    /**
     * Ends the task. Any promises created by the promise() method will be resolved when all outstanding promises
     * have ended.
     */
    public end(): void {
        // Note that this does not trigger more tasks to run. It can resolve a task though.
        debug("Ending task");
        if (this._state < TaskState.Terminated && this._taskGroup._activePromiseCount <= 0) {
            this._state = TaskState.Terminated;

            if (this._taskGroup._activeTaskCount > 0) {
                this._groups.forEach((group) => {
                    group._decrementTasks();
                });
                this._detachCallback(this._groups);
            }
            this._resolve();
        } else if (this._state < TaskState.Exhausted) {
            this._state = TaskState.Exhausted;
        }
    }

    /**
     * Private. Returns false if the task is ready, true if the task is busy with an indeterminate ready time, or the
     * timestamp for when the task will be ready.
     */
    public _busyTime(): boolean | number {
        if (this._state !== TaskState.Active) {
            return true;
        }

        let time: number = 0;
        for (const group of this._groups) {
            const busyTime: boolean | number = group._busyTime();
            if (typeof busyTime === "number") {
                if (busyTime > time) {
                    time = busyTime;
                }
            } else if (busyTime) {
                return true;
            }
        }
        return time ? time : false;
    }

    public _cleanFrequencyStarts(now: number): void {
        this._groups.forEach((group, index) => {
            if (index > GLOBAL_GROUP_INDEX) {
                group._cleanFrequencyStarts(now);
            }
        });
    }

    /**
     * Private. Invokes the task.
     */
    public _run(): void {
        if (this._invocations >= this._invocationLimit) {
            // TODO: Make a test for this
            // This may detach / resolve the task if no promises are active
            this.end();
            return;
        }
        debug("Running task");

        let promise: Promise<any>;
        try {
            promise = this._generator.call(this, this._invocations);
        } catch (err) {
            this._reject(err);
            return;
        }
        if (!promise) {
            if (this._state === TaskState.Active) {
                this.end();
            }
            // Remove the task if needed and start the next task
            return;
        }

        if (!(promise instanceof Promise)) {
            // In case what is returned is not a promise, make it one
            promise = Promise.resolve(promise);
        }
        this._groups.forEach((group) => {
            group._activePromiseCount++;
            if (group._frequencyLimit) {
                group._frequencyStarts.push(Date.now());
            }
        });
        const resultIndex: number = this._invocations;
        this._invocations++;
        if (this._invocations >= this._invocationLimit) {
            // this will not detach the task since there are active promises
            this.end();
        }

        promise.catch((err) => {
            this._reject(err);
            // Resolve
        }).then((result) => {
            this._groups.forEach((group) => {
                group._activePromiseCount--;
            });
            // Avoid storing the result if it is undefined.
            // Some tasks may have countless iterations and never return anything, so this could eat memory.
            if (result !== undefined) {
                this._result[resultIndex] = result;
            }
            if (this._state >= TaskState.Exhausted && this._taskGroup._activePromiseCount <= 0) {
                this.end();
            }
            debug("Promise Count: " + this._taskGroup._activePromiseCount);

            // Remove the task if needed and start the next task
            this._triggerCallback();
        });
    }

    /**
     * Private. Resolves the task if possible. Should only be called by end()
     */
    private _resolve(): void {
        if (this._rejection) {
            return;
        }
        // Set the length of the resulting array in case some undefined results affected this
        this._result.length = this._invocations;

        this._state = TaskState.Terminated;

        if (this._resultConverter) {
            try {
                this._returnResult = this._resultConverter(this._result);
            } catch (err) {
                this._reject(err);
                return;
            }
        } else {
            this._returnResult = this._result;
        }
        // discard the original array to free memory
        this._result = null;

        if (this._promises.length) {
            this._promises.forEach((promise) => {
                promise.resolve(this._returnResult);
            });
            this._promises.length = 0;
        }
    }

    private _reject(err: any) {
        // Check if the task has already failed
        if (this._rejection) {
            debug("This task already failed!");
            // Unhandled promise rejection
            Promise.reject(err);
            return;
        }

        const taskError: TaskError = {
            error: err,
            handled: false,
        };
        this._rejection = taskError;

        // This may detach the task
        this.end();

        if (this._promises.length) {
            taskError.handled = true;
            this._promises.forEach((promise) => {
                promise.reject(taskError.error);
            });
            this._promises.length = 0;
        }
        this._groups.forEach((group) => {
            group._reject(taskError);
        });

        if (!taskError.handled) {
            // Wait a tick to see if the error gets handled
            process.nextTick(() => {
                if (!taskError.handled) {
                    // Unhandled promise rejection
                    debug("Unhandled promise rejection!");
                    Promise.reject(taskError.error);
                }
            });
        }
    }
}
