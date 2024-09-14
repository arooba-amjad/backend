import React, { useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Alert } from 'react-native';

const Game = () => {
  const [board, setBoard] = useState([
    ['', '', ''],
    ['', '', ''],
    ['', '', ''],
  ]);

  const [currentPlayer, setCurrentPlayer] = useState('X');

  const handlePress = (rowIndex, colIndex) => {
    if (board[rowIndex][colIndex] === '') {
      const updatedBoard = [...board];
      updatedBoard[rowIndex][colIndex] = currentPlayer;
      setBoard(updatedBoard);
      checkWinner(updatedBoard);
      setCurrentPlayer(currentPlayer === 'X' ? 'O' : 'X');
    } else {
      Alert.alert('Invalid Move', 'This spot is already taken.');
    }
  };

  const checkWinner = (board) => {
   
    const winningCombos = [
   
      [board[0][0], board[0][1], board[0][2]],
      [board[1][0], board[1][1], board[1][2]],
      [board[2][0], board[2][1], board[2][2]],
    
      [board[0][0], board[1][0], board[2][0]],
      [board[0][1], board[1][1], board[2][1]],
      [board[0][2], board[1][2], board[2][2]],
  
      [board[0][0], board[1][1], board[2][2]],
      [board[0][2], board[1][1], board[2][0]],  
    ];

    for (let combo of winningCombos) {
      if (combo.every(cell => cell === 'X')) {
        Alert.alert('Game Over', 'Player X wins!');
        resetGame();
        return;
      } else if (combo.every(cell => cell === 'O')) {
        Alert.alert('Game Over', 'Player O wins!');
        resetGame();
        return;
      }
    }


    if (board.flat().every(cell => cell !== '')) {
      Alert.alert('Game Over', 'It\'s a draw!');
      resetGame();
    }
  };

  const resetGame = () => {
    setBoard([
      ['', '', ''],
      ['', '', ''],
      ['', '', ''],
    ]);
    setCurrentPlayer('X');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Tic Tac Toe</Text>
      <View style={styles.board}>
        {board.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.row}>
            {row.map((cell, colIndex) => (
              <TouchableOpacity
                key={colIndex}
                style={styles.cell}
                onPress={() => handlePress(rowIndex, colIndex)}
              >
                <Text style={styles.cellText}>{cell}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ))}
      </View>
      <TouchableOpacity style={styles.resetButton} onPress={resetGame}>
        <Text style={styles.resetButtonText}>Reset Game</Text>
      </TouchableOpacity>
    </View>
  );
};

export default Game;

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 20,
    color: '#333',
  },
  board: {
    borderWidth: 2,
    borderColor: '#333',
  },
  row: {
    flexDirection: 'row',
  },
  cell: {
    width: 100,
    height: 100,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  cellText: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#333',
  },
  resetButton: {
    marginTop: 20,
    backgroundColor: '#2980b9',
    padding: 10,
    borderRadius: 5,
  },
  resetButtonText: {
    color: '#fff',
    fontSize: 18,
  },
});
