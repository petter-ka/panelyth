//go:build !windows

package main

func setNoBuffering(int) {}

func noBufferingMB() int { return -1 }
