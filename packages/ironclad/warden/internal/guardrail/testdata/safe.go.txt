package main

import "fmt"

func main() {
	result := add(1, 2)
	fmt.Println(result)
}

func add(a, b int) int {
	return a + b
}
