import React, { useState } from 'react';
import { SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

export default function App() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState('');

  const onButtonPress = (value) => {
    if (value === '=') {
      try {
        setResult(eval(input));
      } catch (error) {
        setResult('Error');
      }
    } else if (value === 'C') {
      setInput('');
      setResult('');
    } else {
      setInput(prevInput => prevInput + value);
    }
  };

  const CalculatorScreen = () => {
    return (
      <View style={styles.container}>
        <View style={styles.resultContainer}>
          <Text style={styles.resultText}>0</Text>
        </View>
        <View style={styles.inputContainer}>
          <Text style={styles.inputText}>12345</Text>
        </View>
        <View style={styles.buttonContainer}>
          <TouchableOpacity style={[styles.Button, styles.addButton]}>
            <Text style={styles.buttonText}>+</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.Button, styles.subtractButton]}>
            <Text style={styles.buttonText}>-</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.Button, styles.multiplyButton]}>
            <Text style={styles.buttonText}>*</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.Button, styles.divideButton]}>
            <Text style={styles.buttonText}>/</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };
  
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />
      <View style={styles.resultContainer}>
        <Text style={styles.resultText}>{result}</Text>
      </View>
      <View style={styles.inputContainer}>
        <Text style={styles.inputText} keyboardType="numeric">
          {input}
        </Text>
        <View style={styles.buttonContainer}>
          {['7', '8', '9', '/', '4', '5', '6', '*', '1', '2', '3', '-', '0', 'C', '=', '+'].map(
            (item, index) => (
              <TouchableOpacity
                key={index}
                style={styles.Button}
                onPress={() => onButtonPress(item)}
              >
                <Text style={styles.buttonText}>{item}</Text>
              </TouchableOpacity>
            )
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'black',
  },

  resultContainer: {
    height: 200,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingRight: 10,
  },

  resultText:
  {
    fontSize: 28,
    fontStyle: 'normal',
    color: 'white',
  },
  inputContainer:
  {
    flex: 1,
    justifyContent: 'flex-start',
    alignItems: 'stretch',
  },

  inputText: {
    height: 150,
    width: '100%',
    textAlign: 'right',
    fontSize: 26,
    color: 'white'
  },

  buttonContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },

  Button: {
    width: 88,
    height: 100,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'grey',
    backgroundColor: 'black',
    margin: 4,
    padding:10,
    borderCurve:'10'
  },

  buttonText: {
    fontSize: 30,
    color: 'white',
  },


});
