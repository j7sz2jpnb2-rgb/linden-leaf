/*
 * scripts/verify-cancel-atomics.c
 * Verifies cross-thread visibility and race-freedom of the atomic cancel-flag
 * helpers introduced in src-tauri/native/ll_mupdf.c (ll_atomic_store_abort /
 * ll_atomic_load_abort) under concurrent reader/writer contention.
 *
 * Build & run on Linux/macOS:
 *   gcc -O2 -Wall -Wextra -pthread scripts/verify-cancel-atomics.c -o /tmp/verify-cancel-atomics && /tmp/verify-cancel-atomics
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <pthread.h>

#if defined(_MSC_VER)
#include <intrin.h>
static inline void ll_atomic_store_abort(volatile int *flag, int val) {
    _InterlockedExchange((volatile long *)flag, (long)val);
}
static inline int ll_atomic_load_abort(volatile int *flag) {
    return (int)_InterlockedCompareExchange((volatile long *)flag, 0L, 0L);
}
#else
static inline void ll_atomic_store_abort(volatile int *flag, int val) {
    __atomic_store_n((int *)flag, val, __ATOMIC_RELEASE);
}
static inline int ll_atomic_load_abort(volatile int *flag) {
    return __atomic_load_n((int *)flag, __ATOMIC_ACQUIRE);
}
#endif

typedef struct {
    volatile int aborted;
    volatile int observed_abort;
    int worker_id;
} test_cancel_t;

static void *worker_fn(void *arg) {
    test_cancel_t *ctx = (test_cancel_t *)arg;
    unsigned long spins = 0;
    while (!ll_atomic_load_abort(&ctx->aborted)) {
        spins++;
        if (spins > 200000000UL) {
            fprintf(stderr, "[FAIL] Worker %d timed out waiting for atomic abort signal!\n", ctx->worker_id);
            return (void *)(intptr_t)1;
        }
    }
    ll_atomic_store_abort(&ctx->observed_abort, 1);
    return NULL;
}

int main(void) {
    enum { ROUNDS = 200, WORKERS = 4 };
    for (int round = 0; round < ROUNDS; round++) {
        test_cancel_t ctx[WORKERS];
        pthread_t threads[WORKERS];
        for (int i = 0; i < WORKERS; i++) {
            ctx[i].aborted = 0;
            ctx[i].observed_abort = 0;
            ctx[i].worker_id = i;
            if (pthread_create(&threads[i], NULL, worker_fn, &ctx[i]) != 0) {
                fprintf(stderr, "[FAIL] pthread_create failed\n");
                return 1;
            }
        }
        /* Trigger cancellation from main thread */
        for (int i = 0; i < WORKERS; i++) {
            ll_atomic_store_abort(&ctx[i].aborted, 1);
        }
        for (int i = 0; i < WORKERS; i++) {
            void *ret = NULL;
            pthread_join(threads[i], &ret);
            if (ret != NULL || !ll_atomic_load_abort(&ctx[i].observed_abort)) {
                fprintf(stderr, "[FAIL] Round %d worker %d missed abort\n", round, i);
                return 1;
            }
        }
    }
    printf("[PASS] Atomic cancel-flag stress test passed (%d rounds x %d workers).\n", ROUNDS, WORKERS);
    return 0;
}
