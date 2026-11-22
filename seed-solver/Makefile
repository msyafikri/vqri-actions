CC      ?= gcc
CFLAGS  ?= -O3 -march=native -Wall -Wextra -std=gnu11
SRC      = src/seed_solver.c
BIN      = seed_solver

# libsodium is optional: used only for the (faster) Ed25519 pubkey path.
# Link whatever the loader knows about (dev symlink or versioned runtime lib).
SODIUM := $(shell ldconfig -p 2>/dev/null | grep -o '/[^ ]*libsodium\.so[^ ]*' | head -1)
ifeq ($(SODIUM),)
SODIUM := $(shell ls /usr/lib/*/libsodium.so /usr/lib/libsodium.so 2>/dev/null | head -1)
endif

ifneq ($(SODIUM),)
CFLAGS += -DHAVE_SODIUM
LDLIBS += $(SODIUM)
endif
LDLIBS += -lcrypto

all: $(BIN)

$(BIN): $(SRC) src/words.h
	$(CC) $(CFLAGS) -o $@ $(SRC) $(LDLIBS)
	@echo "built $(BIN) (sodium: $(if $(SODIUM),$(SODIUM),none))"

clean:
	rm -f $(BIN)

.PHONY: all clean
